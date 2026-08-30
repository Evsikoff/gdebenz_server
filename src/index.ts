import { createGameServer } from "./server.js";

const host = process.env.HOST ?? "0.0.0.0";
const parsedPort = Number.parseInt(process.env.PORT ?? "8080", 10);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65_535 ? parsedPort : 8080;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const gameServer = createGameServer({ host, port, allowedOrigins });
const address = await gameServer.start();
console.log(`gdebenz-server принимает подключения на ws://${address.host}:${address.port}/ws`);

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`Получен сигнал ${signal}; сервер завершает работу`);
  await gameServer.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
