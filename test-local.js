// =============================================================================
// Quick Test Script
// =============================================================================
// Simulates a WhatsApp message to test the bridge WITHOUT needing WhatsApp
// 
// Usage: node test-local.js "Your test message here"
// =============================================================================

const axios = require("axios");

const PORT = process.env.PORT || 3000;
const message = process.argv.slice(2).join(" ") || "What files are in this project?";

async function testBridge() {
  console.log("\n🧪 Testing WhatsApp Bridge locally...\n");
  console.log(`📩 Sending message: "${message}"\n`);

  try {
    // Simulate a WhatsApp webhook payload
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "TEST_ENTRY",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "0000000000",
                  phone_number_id: "TEST",
                },
                messages: [
                  {
                    from: process.env.MY_WHATSAPP_NUMBER || "919999999999",
                    id: "test_" + Date.now(),
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    text: { body: message },
                    type: "text",
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const response = await axios.post(
      `http://localhost:${PORT}/webhook`,
      payload,
      { headers: { "Content-Type": "application/json" } }
    );

    console.log(`✅ Webhook returned: ${response.status}`);
    console.log("\n📡 The message is now being processed by the agent.");
    console.log("   Check the server console for the agy response.\n");
    console.log("   (The WhatsApp reply will fail since this is a test,");
    console.log("    but you'll see the agent's response in the server logs.)\n");

  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    console.error("\n   Make sure the bridge server is running (npm start)\n");
  }
}

testBridge();
