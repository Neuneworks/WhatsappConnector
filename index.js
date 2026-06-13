import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ─── ENV VARIABLES ────────────────────────────────────────────────────────────
// Set these in your server environment or a .env file (use dotenv if preferred)
const WA_TOKEN        = process.env.WA_TOKEN;         // WhatsApp Cloud API token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;  // Your WA phone number ID
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;     // Any secret string you choose
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;    // Your Claude API key


// ─── STEP 1: WEBHOOK VERIFICATION ────────────────────────────────────────────
// Meta calls this GET route once when you register the webhook URL.
// It sends a challenge string — you must echo it back to confirm the URL is yours.
app.get("/sync", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified by Meta");
    res.status(200).send(challenge); // echo back the challenge
  } else {
    console.error("Webhook verification failed — token mismatch");
    res.sendStatus(403);
  }
});


// ─── STEP 2: RECEIVE INCOMING MESSAGES ───────────────────────────────────────
// Meta POSTs here every time someone sends a message to your WA number.
app.post("/order", async (req, res) => {

  // Always reply 200 immediately — Meta will retry if you don't respond fast
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    // Ignore non-message events (delivery receipts, read status, etc.)
    if (!message || message.type !== "text") return;

    const from        = message.from;          // sender's phone number e.g. "0123456789"
    const messageText = message.text.body;     // the actual message content
    const to          = changes?.metadata?.phone_number_id; // which of YOUR numbers received it

    console.log(`Message from ${from}: ${messageText}`);

    // ── STEP 3: SEND TO CLAUDE ──────────────────────────────────────────────
    const invoiceData = await parseOrderWithClaude(messageText, from);

    // ── STEP 4: REPLY ON WHATSAPP ───────────────────────────────────────────
    if (invoiceData.error) {
      console.log("Claude parsing failed or message not an order:", invoiceData.reply);
      // Claude couldn't parse a valid order — ask for clarification
      await sendWhatsAppMessage(from, invoiceData.reply, to);
    } else {
      // Valid order parsed — confirm and send invoice summary
      console.log("Order parsed successfully:", invoiceData);
      const reply = buildConfirmationMessage(invoiceData);
      await sendWhatsAppMessage(from, reply, to);
    }

  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});


// ─── CLAUDE: PARSE ORDER FROM MESSAGE ────────────────────────────────────────
// Sends the raw WhatsApp message to Claude and gets back structured order data.
async function parseOrderWithClaude(messageText, senderPhone) {

  const prompt = `
You are a B2B order processing assistant. A business has sent the following WhatsApp message.
Extract the order details and respond ONLY with a JSON object — no explanation, no markdown.

Message: "${messageText}"
Sender phone: ${senderPhone}

If this is a valid order, respond with:
{
  "isOrder": true,
  "sender": "${senderPhone}",
  "items": [
    { "name": "item name", "quantity": 10, "unitPrice": 25.00 }
  ],
  "notes": "any special instructions or empty string",
  "currency": "USD"
}

If the message is NOT a valid order (e.g. a greeting, question, or unclear request), respond with:
{
  "isOrder": false,
  "reply": "A friendly message asking them to clarify or place an order properly"
}

Rules:
- Infer unit prices only if stated. If price is missing, set unitPrice to null.
- Extract currency from context (AED, USD, EUR, etc.) — default to USD if not mentioned.
- Be flexible with natural language: "50 units of widget A" or "pls send 50x widget A" both work.
`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  const raw  = data.content?.[0]?.text?.trim();

  try {
    const parsed = JSON.parse(raw);
    if (!parsed.isOrder) {
      return { error: true, reply: parsed.reply };
    }
    return parsed;
  } catch {
    console.error("Claude returned non-JSON:", raw);
    return {
      error: true,
      reply: "Sorry, I had trouble processing your order. Please resend it with item names and quantities.",
    };
  }
}


// ─── BUILD CONFIRMATION MESSAGE ───────────────────────────────────────────────
// Formats the parsed order into a clean WhatsApp reply text.
function buildConfirmationMessage(order) {
  const symbol = currencySymbol(order.currency);
  let total    = 0;

  const lineItems = order.items.map((item) => {
    if (item.unitPrice !== null) {
      const lineTotal = item.quantity * item.unitPrice;
      total += lineTotal;
      return `  • ${item.name}: ${item.quantity} x ${symbol}${item.unitPrice.toFixed(2)} = ${symbol}${lineTotal.toFixed(2)}`;
    }
    return `  • ${item.name}: ${item.quantity} units (price TBC)`;
  }).join("\n");

  const hasPrices = order.items.every((i) => i.unitPrice !== null);

  let message = `Order received — here's your summary:\n\n${lineItems}`;

  if (hasPrices) {
    message += `\n\n  Total: ${symbol}${total.toFixed(2)} ${order.currency}`;
  }

  if (order.notes) {
    message += `\n\n  Notes: ${order.notes}`;
  }

  message += "\n\nWe'll send your invoice shortly. Reply CANCEL to cancel this order.";

  return message;
}

function currencySymbol(currency) {
  const map = { USD: "$", EUR: "€", GBP: "£", AED: "AED ", SAR: "SAR " };
  return map[currency] ?? (currency + " ");
}


// ─── SEND WHATSAPP MESSAGE ────────────────────────────────────────────────────
// Calls the WhatsApp Cloud API to send a text reply back to the sender.
// `phoneNumberId` is WHICH of your numbers sends the reply —
// this is what lets you run multiple numbers from one webhook.
async function sendWhatsAppMessage(to, text, phoneNumberId) {

  // Fall back to env var if not passed (single-number setup)
  const numId = phoneNumberId || PHONE_NUMBER_ID;

  const url = `https://graph.facebook.com/v19.0/${numId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text },
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("WhatsApp send failed:", JSON.stringify(result));
  } else {
    console.log(`Reply sent to ${to}, message ID: ${result.messages?.[0]?.id}`);
  }
}


// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
