import Fastify from "fastify";
import cors from "@fastify/cors";
import { pipelineRoutes } from "./routes/pipeline.js";

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: true,
  });

  app.get("/", async () => ({ message: "Welcome to the API" }));
  app.get("/health", async () => ({ status: "ok" }));
  await app.register(pipelineRoutes);

  return app;
}

const server = await buildServer();

export default server;
