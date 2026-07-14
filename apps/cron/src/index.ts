import cron from "node-cron";

console.log("[cron] Cron process starting...");

cron.schedule("* * * * *", () => {
  console.log("[cron] reminder sweep tick");
});

process.on("SIGTERM", () => {
  console.log("[cron] SIGTERM received, shutting down gracefully");
  process.exit(0);
});
