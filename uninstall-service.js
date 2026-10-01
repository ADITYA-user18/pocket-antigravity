// =============================================================================
// Uninstall WhatsApp Bridge Windows Service
// =============================================================================
// Run: node uninstall-service.js
// =============================================================================

const path = require("path");
const Service = require("node-windows").Service;

const svc = new Service({
  name: "WhatsApp Antigravity Bridge",
  script: path.join(__dirname, "server.js"),
});

svc.on("uninstall", () => {
  console.log("\n✅ Service uninstalled successfully!");
  console.log("   The bridge will no longer auto-start on boot.\n");
  console.log("   To reinstall: node install-service.js\n");
});

svc.on("error", (err) => {
  console.error("❌ Error:", err);
});

console.log("\n🔧 Uninstalling WhatsApp Bridge Windows Service...\n");
svc.uninstall();
