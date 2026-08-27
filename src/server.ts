import { createServer, type Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { CONFIG, type GameConfig } from "./config.js";
import { GameRoom, RoomError } from "./game-room.js";
import { parseClientMessage, PROTOCOL_VERSION, type ServerMessage } from "./protocol.js";

interface ClientSession {
  socket: WebSocket;
  playerId: string | null;
  alive: boolean;
}

export interface GameServerOptions {
  host?: string;
  port?: number;
  allowedOrigins?: string[];
  config?: GameConfig;
}

export interface RunningGameServer {
  room: GameRoom;
  httpServer: HttpServer;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
}

export function createGameServer(options: GameServerOptions = {}): RunningGameServer {
  const config = options.config ?? CONFIG;
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8080;
  const allowedOrigins = options.allowedOrigins ?? ["*"];
  const room = new GameRoom(config);
  const clients = new Set<ClientSession>();

  const httpServer = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/health") {
      response.writeHead(200);
      response.end(
        JSON.stringify({
          ok: true,
          players: room.playerCount,
          bots: room.botCount,
          worldRevision: room.revision,
          mapScale: room.city.meta.scale,
        }),
      );
      return;
    }
    if (request.url === "/" || request.url === "/protocol") {
      response.writeHead(200);
      response.end(
        JSON.stringify({
          name: "gdebenz-server",
          protocolVersion: PROTOCOL_VERSION,
          websocket: "/ws",
          health: "/health",
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not-found" }));
  });

  const websocketServer = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: config.maxClientMessageBytes,
    verifyClient: ({ origin }, done) => {
      const accepted = allowedOrigins.includes("*") || !origin || allowedOrigins.includes(origin);
      done(accepted, accepted ? 200 : 403, accepted ? "OK" : "Origin is not allowed");
    },
  });

  const send = (session: ClientSession, message: ServerMessage): void => {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
  };

  const broadcast = (message: ServerMessage): void => {
    const serialized = JSON.stringify(message);
    for (const session of clients) {
      if (session.playerId && session.socket.readyState === WebSocket.OPEN) session.socket.send(serialized);
    }
  };

  room.on("message", broadcast);

  websocketServer.on("connection", (socket) => {
    const session: ClientSession = { socket, playerId: null, alive: true };
    clients.add(session);
    send(session, {
      type: "server:hello",
      payload: { protocolVersion: PROTOCOL_VERSION, tickRate: config.tickRate, snapshotRate: config.snapshotRate },
    });

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        sendError(session, send, "binary-not-supported", "Only JSON text messages are accepted");
        return;
      }
      const parsed = parseClientMessage(raw.toString());
      if (!parsed.ok) {
        sendError(session, send, "invalid-message", parsed.error);
        return;
      }
      const message = parsed.value;

      if (message.type === "ping") {
        const payload: Extract<ServerMessage, { type: "pong" }>["payload"] = { serverTime: Date.now() };
        if (message.payload.clientTime !== undefined) payload.clientTime = message.payload.clientTime;
        send(session, { type: "pong", payload });
        return;
      }

      if (message.type === "player:join") {
        if (session.playerId) {
          sendError(session, send, "already-joined", "This connection already has a player");
          return;
        }
        try {
          const player = room.addPlayer(message.payload.name);
          session.playerId = player.id;
          send(session, { type: "player:welcome", payload: { playerId: player.id, player: room.getPublicPlayer(player.id)! } });
          send(session, room.worldSnapshot());
        } catch (error) {
          if (error instanceof RoomError) sendError(session, send, error.code, error.message);
          else sendError(session, send, "join-failed", "Could not join the room");
        }
        return;
      }

      if (!session.playerId) {
        sendError(session, send, "join-required", "Send player:join before gameplay messages");
        return;
      }

      if (message.type === "player:input") {
        const result = room.setInput(session.playerId, message.payload);
        if (!result.ok) sendError(session, send, result.code, "Player input was rejected");
        return;
      }
      if (message.type === "player:move") {
        const result = room.applyClientMove(session.playerId, message.payload);
        if (!result.ok) sendError(session, send, result.code, "Player movement was rejected");
        return;
      }
      if (message.type === "world:interact") {
        try {
          send(session, room.interact(session.playerId, message.payload));
        } catch (error) {
          if (error instanceof RoomError) sendError(session, send, error.code, error.message, message.payload.requestId);
          else sendError(session, send, "interaction-failed", "Interaction failed", message.payload.requestId);
        }
        return;
      }
      if (message.type === "player:fuel-filled") {
        send(
          session,
          room.reportFuelFilled(
            session.playerId,
            message.payload.requestId,
            message.payload.stationId,
            message.payload.liters,
          ),
        );
        return;
      }
      if (message.type === "station:blocked") {
        send(
          session,
          room.reportStationBlocked(session.playerId, message.payload.requestId, message.payload.stationId),
        );
        return;
      }
      if (message.type === "billboard:interacted") {
        send(
          session,
          room.reportBillboardInteraction(session.playerId, message.payload.requestId, message.payload.billboardId),
        );
        return;
      }
      if (message.type === "player:lost") {
        send(session, room.reportPlayerLost(session.playerId, message.payload.requestId, message.payload.reason));
        return;
      }
      if (message.type === "player:respawn") {
        send(session, room.respawnPlayer(session.playerId, message.payload.requestId));
      }
    });

    socket.on("close", () => {
      clients.delete(session);
      if (session.playerId) room.removePlayer(session.playerId);
    });

    socket.on("error", () => {
      // close удалит игрока; ошибка сокета не должна останавливать комнату.
    });
  });

  let lastTick = performance.now();
  const simulationTimer = setInterval(() => {
    const now = performance.now();
    const dt = (now - lastTick) / 1_000;
    lastTick = now;
    room.step(dt);
  }, 1_000 / config.tickRate);
  simulationTimer.unref();

  const heartbeatTimer = setInterval(() => {
    for (const session of clients) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }, 30_000);
  heartbeatTimer.unref();

  return {
    room,
    httpServer,
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          const boundPort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: boundPort });
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        clearInterval(simulationTimer);
        clearInterval(heartbeatTimer);
        room.off("message", broadcast);
        for (const session of clients) session.socket.terminate();
        websocketServer.close(() => {
          if (!httpServer.listening) resolve();
          else httpServer.close(() => resolve());
        });
      }),
  };
}

function sendError(
  session: ClientSession,
  send: (session: ClientSession, message: ServerMessage) => void,
  code: string,
  message: string,
  requestId?: string,
): void {
  const payload: Extract<ServerMessage, { type: "server:error" }>["payload"] = { code, message };
  if (requestId !== undefined) payload.requestId = requestId;
  send(session, { type: "server:error", payload });
}
