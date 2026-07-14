console.log("[worker] BullMQ worker process starting...");

process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM received, shutting down gracefully");
  process.exit(0);
});
