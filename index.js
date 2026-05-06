const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

const {
  AMAZON_CLIENT_ID,
  AMAZON_CLIENT_SECRET,
  AMAZON_REFRESH_TOKEN,
  ANTHROPIC_API_KEY,
  PACKLINK_API_KEY,
  PORT = 3000,
} = process.env;

const SYSTEM_PROMPT = `Tu es l'assistant SAV officiel de BarberCosmetic, boutique e-commerce sur Amazon.
Tu as accès aux informations de suivi en temps réel via PacklinkPro.

TRANSPORTEURS : Colis Privé, Mondial Relay, UPS, Chronopost, Colissimo (France et Europe)

STATUTS EN TRANSIT :
- "En transit" → en route, normal sous 2-3 jours
- "En attente" → normal sous 24h
- "En instance" → tentative échouée, inviter à reprogrammer
- "Livré" contesté → voir procédure litige
- "Incident" → escalader à mlecflow@gmail.com
- Pas de mouvement +5 jours ouvrés → investigation à ouvrir

COLIS LIVRÉ MAIS NON REÇU :
Étape 1 - Vérifications : boîte aux lettres, voisins, point relais, avis de passage
Étape 2 - Demander d'envoyer à mlecflow@gmail.com :
  - Objet : "Contestation livraison - N° de suivi XXXXX"
  - Lettre sur l'honneur
  - Pièce d'identité (CNI ou passeport)
Ne jamais promettre un remboursement immédiat sans les documents.

RETOUR : accepté sous 30 jours, produit non utilisé. Remboursement sous 5-7 jours.
PRODUIT DÉFECTUEUX : photo demandée + échange ou remboursement au choix client.
RÈGLES : vouvoyer, ton chaleureux, réponses courtes (4-5 phrases max), contact : mlecflow@gmail.com`;

// ─── AMAZON TOKEN ─────────────────────────────────────────
async function getAmazonAccessToken() {
  const response = await axios.post(
    "https://api.amazon.com/auth/o2/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: AMAZON_REFRESH_TOKEN,
      client_id: AMAZON_CLIENT_ID,
      client_secret: AMAZON_CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return response.data.access_token;
}

// ─── AMAZON MESSAGES ──────────────────────────────────────
async function getUnreadMessages(accessToken) {
  try {
    const response = await axios.get(
      "https://sellingpartnerapi-eu.amazon.com/messaging/v1/orders?marketplaceIds=A13V1IB3VIYZZH&pageSize=10",
      {
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
          "x-amz-date": new Date().toISOString(),
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur lecture messages Amazon:", error.response?.data || error.message);
    return null;
  }
}

async function replyToAmazonMessage(accessToken, orderId, message) {
  try {
    const response = await axios.post(
      `https://sellingpartnerapi-eu.amazon.com/messaging/v1/orders/${orderId}/messages/confirmCustomizationDetails`,
      { text: message },
      {
        headers: {
          "x-amz-access-token": accessToken,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur réponse Amazon:", error.message);
    return null;
  }
}

// ─── PACKLINK ─────────────────────────────────────────────
async function searchPacklinkByOrder(orderId) {
  try {
    // Cherche par référence externe Amazon
    const response = await axios.get(
      `https://api.packlink.com/v1/shipments?keywords=${encodeURIComponent(orderId)}&limit=5`,
      {
        headers: {
          "Authorization": PACKLINK_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur PacklinkPro:", error.response?.data || error.message);
    return null;
  }
}

async function getPacklinkTracking(shipmentRef) {
  try {
    const response = await axios.get(
      `https://api.packlink.com/v1/shipments/${shipmentRef}/track`,
      {
        headers: {
          "Authorization": PACKLINK_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur tracking PacklinkPro:", error.message);
    return null;
  }
}

// ─── CLAUDE ───────────────────────────────────────────────
async function generateReply(customerMessage, trackingInfo = null, orderInfo = null) {
  let context = "";
  if (orderInfo) context += `[COMMANDE AMAZON]\n${JSON.stringify(orderInfo, null, 2)}\n\n`;
  if (trackingInfo) context += `[SUIVI PACKLINK EN TEMPS RÉEL]\n${JSON.stringify(trackingInfo, null, 2)}\n\n`;
  context += `[MESSAGE CLIENT]\n${customerMessage}`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: context }],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );
  return response.data.content[0].text;
}

// ─── TRAITEMENT AUTO MESSAGES AMAZON ──────────────────────
async function processAmazonMessages() {
  try {
    console.log("🔄 Vérification messages Amazon...");
    const accessToken = await getAmazonAccessToken();
    const messages = await getUnreadMessages(accessToken);

    if (!messages || !messages.orders) {
      console.log("Aucun message à traiter");
      return { processed: 0 };
    }

    let processed = 0;
    for (const order of messages.orders) {
      const orderId = order.orderId;
      const customerMessage = order.latestMessage?.text;
      if (!customerMessage) continue;

      // Cherche le suivi PacklinkPro
      let trackingInfo = null;
      const shipments = await searchPacklinkByOrder(orderId);
      if (shipments && shipments.length > 0) {
        trackingInfo = await getPacklinkTracking(shipments[0].reference);
      }

      // Génère la réponse Claude
      const reply = await generateReply(customerMessage, trackingInfo, { orderId });

      // Répond sur Amazon
      await replyToAmazonMessage(accessToken, orderId, reply);
      processed++;
      console.log(`✅ Répondu à la commande ${orderId}`);
    }

    return { processed };
  } catch (error) {
    console.error("Erreur traitement messages:", error.message);
    return { error: error.message };
  }
}

// Lance la vérification toutes les 5 minutes
setInterval(processAmazonMessages, 5 * 60 * 1000);

// ─── ROUTES ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "BarberCosmetic SAV en ligne ✅",
    transporteurs: ["Colis Privé", "Mondial Relay", "UPS", "Chronopost", "Colissimo"],
    packlink: PACKLINK_API_KEY ? "connecté ✅" : "non configuré ❌",
    autoReply: "actif — vérification toutes les 5 minutes ✅",
  });
});

app.post("/process", async (req, res) => {
  const result = await processAmazonMessages();
  res.json(result);
});

app.post("/reply", async (req, res) => {
  try {
    const { message, orderId, customerName } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    let trackingInfo = null;
    if (orderId) {
      const shipments = await searchPacklinkByOrder(orderId);
      if (shipments && shipments.length > 0) {
        trackingInfo = await getPacklinkTracking(shipments[0].reference);
      }
    }

    const reply = await generateReply(message, trackingInfo, orderId ? { orderId } : null);
    res.json({ reply, trackingFound: !!trackingInfo });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SAV BarberCosmetic démarré sur le port ${PORT}`);
  // Lance une première vérification au démarrage
  setTimeout(processAmazonMessages, 10000);
});
