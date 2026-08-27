import { once } from "node:events";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { createGameServer } from "../src/server.js";

describe("WebSocket server", () => {
  it("serves health and completes the join handshake", async () => {
    const server = createGameServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((response) => response.json());
    expect(health).toMatchObject({ ok: true, players: 0, bots: 10, mapScale: 1 });

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const inbox = createInbox(socket);
    await once(socket, "open");
    expect((await inbox.next()).type).toBe("server:hello");

    socket.send(JSON.stringify({ type: "player:join", payload: { name: "Сетевой игрок" } }));
    const welcome = await inbox.next("player:welcome");
    const snapshot = await inbox.next("world:snapshot");
    expect(welcome.payload.player.name).toBe("Сетевой игрок");
    expect(snapshot.payload.entities.players).toHaveLength(1);
    expect(snapshot.payload.entities.bots).toHaveLength(9);
    expect(snapshot.payload.map.base.id).toBe("base");
    expect(snapshot.payload.leaderboard).toHaveLength(10);

    socket.send(
      JSON.stringify({ type: "player:lost", payload: { requestId: "lost-network-1", reason: "out-of-fuel" } }),
    );
    const despawned = await inbox.next("player:despawned");
    const lostResult = await inbox.next("game:event-result");
    expect(despawned.payload.playerId).toBe(welcome.payload.playerId);
    expect(lostResult.payload).toMatchObject({
      requestId: "lost-network-1",
      event: "player-lost",
      ok: true,
    });

    socket.send(JSON.stringify({ type: "player:respawn", payload: { requestId: "respawn-network-1" } }));
    const respawned = await inbox.next("player:respawned");
    const respawnResult = await inbox.next("game:event-result");
    expect(respawned.payload.player.status).toBe("active");
    expect(respawnResult.payload).toMatchObject({
      requestId: "respawn-network-1",
      event: "player-respawn",
      ok: true,
    });

    socket.close();
    await once(socket, "close");
    await server.stop();
  });
});

function createInbox(socket: WebSocket): { next(type?: string): Promise<any> } {
  const queue: any[] = [];
  const waiters: Array<{ type?: string; resolve: (message: any) => void }> = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => !waiter.type || waiter.type === message.type);
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter!.resolve(message);
    } else {
      queue.push(message);
    }
  });
  return {
    next(type?: string): Promise<any> {
      const queuedIndex = queue.findIndex((message) => !type || message.type === type);
      if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
      return new Promise((resolve) => waiters.push(type ? { type, resolve } : { resolve }));
    },
  };
}
