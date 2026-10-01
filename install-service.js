// =============================================================================
// Install WhatsApp Bridge as a Windows Service
// =============================================================================
// Run this ONCE: node install-service.js
// The service will then auto-start on every system boot.
//
// To uninstall: node uninstall-service.js
// =============================================================================

const path = require("path");
const Service = require("node-windows").Service;

// Create a new service object
const svc = new Service({
  name: "WhatsApp Antigravity Bridge",
  description:
    "Bridges WhatsApp messages to the Antigravity IDE agent (agy CLI). Auto-starts on boot.",
  script: path.join(__dirname, "server.js"),
  nodeOptions: [],
  env: [
    {
      name: "NODE_ENV",
      value: "production",
    },
  ],
  // Restart on failure
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

// Listen for install events
svc.on("install", () => {
  console.log("\n✅ Service installed successfully!");
  console.log("\nStarting the service...");
  svc.start();
});

svc.on("start", () => {
  console.log("✅ Service started!");
  console.log("\n====================================================");
  console.log("  The WhatsApp Bridge is now running as a Windows");
  console.log("  Service. It will auto-start every time your");
  console.log("  system boots up.");
  console.log("====================================================");
  console.log("\nTo check status:  services.msc → 'WhatsApp Antigravity Bridge'");
  console.log("To view logs:     Check d:\\tftr\\whatsapp-bridge\\logs\\");
  console.log("To uninstall:     node uninstall-service.js\n");
});

svc.on("alreadyinstalled", () => {
  console.log("⚠️  Service is already installed. Starting it...");
  svc.start();
});

svc.on("error", (err) => {
  console.error("❌ Error:", err);
});

// Install the service
console.log("\n🔧 Installing WhatsApp Bridge as a Windows Service...\n");
console.log("   Service name: WhatsApp Antigravity Bridge");
console.log("   Script: " + path.join(__dirname, "server.js"));
console.log("   Auto-start: Yes (on system boot)");
console.log("   Auto-restart: Yes (on crash, up to 10 times)\n");

svc.install();
