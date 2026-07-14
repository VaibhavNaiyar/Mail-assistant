console.log("[gmail-pull-worker] Gmail history polling worker starting...");

process.on("SIGTERM", () => {
  console.log("[gmail-pull-worker] SIGTERM received, shutting down gracefully");
  process.exit(0);
});
