import "dotenv/config";
import server from "./server.js";

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

async function main() {
  await server.listen({ port, host });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
