const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  ANTHROPIC_API_KEY,
  TRACKINGMORE_API_KEY,
  PORT = 3000,
} = process.env;

const SYSTEM_PROMPT = `Tu es l'assistant SAV officiel de BarberCosmetic, boutique e-commerce sur Amazon.
Tu as accès aux informations de suivi en temps réel.

TRANSPORTEURS : Colis Privé, Mondial Relay, UPS, Chronopost, Colissimo (France et Europe)

STATUTS :
- "transit" → en route, normal sous 2-3 jours
- "pending" → en attente, normal sous 24h
- "undelivered" → tentative échouée, inviter à reprogrammer
- "delivered" contesté → procédure litige
- "exception" → problème, escalader à mlecflow@gmail.com
- Pas de mouvement +5 jours → investigation à ouvrir

COLIS LIVRÉ MAIS NON REÇU :
Étape 1 - Vérifications : boîte aux lettres, voisins, point relais, avis de passage
Étape 2 - Envoyer à mlecflow@gmail.com :
  - Objet : "Contestation livraison - N° de suivi XXXXX"
  - Lettre sur l'honneur
  - Pièce d'identité (CNI ou passeport)
Ne jamais promettre un remboursement immédiat sans les documents.

RETARD : excuses sincères + statut + investigation si +5 jours sans mouvement.
RETOUR : accepté sous 30 jours. Remboursement sous 5-7 jours après réception.
PRODUIT DÉFECTUEUX : photo demandée + échange ou remboursement au choix.

RÈGLES : vouvoyer, ton chaleureux, réponses courtes (4-5 phrases max), contact : mlecflow@gmail.com`;

// ─── TRACKINGMORE ─────────────────────────────────────────
async function getTrackingInfo(trackingNumber, carrier, postalCode) {
  const headers = {
    "Tracking-Api-Key": TRACKINGMORE_API_KEY,
    "Content-Type": "application/json",
  };

  // Étape 1 : créer le tracking
  try {
    const createRes = await axios.post(
      "https://api.trackingmore.com/v4/trackings/create",
      {
        tracking_number: trackingNumber,
        courier_code: carrier,
        tracking_postal_code: postalCode || undefined,
      },
      { headers }
    );
    console.log("TrackingMore create response:", JSON.stringify(createRes.data));
    const data = createRes.data?.data;
    if (data && data.delivery_status) {
      return {
        status: data.delivery_status,
        carrier: data.courier_name,
        lastEvent: data.latest_event_info,
        lastUpdate: data.latest_checkpoint_time,
        trackingNumber,
      };
    }
  } catch (e) {
    console.log("Create error (peut être déjà existant):", e.response?.data || e.message);
  }

  // Étape 2 : récupérer via GET
  try {
    const getRes = await axios.get(
      `https://api.trackingmore.com/v4/trackings`,
      {
        headers,
        params: {
          tracking_numbers: trackingNumber,
          courier_code: carrier,
        }
      }
    );
    console.log("TrackingMore get response:", JSON.stringify(getRes.data));
    const items = getRes.data?.data?.items;
    const data = items?.[0];
    if (!data) return null;
    return {
      status: data.delivery_status,
      carrier: data.courier_name,
      lastEvent: data.latest_event_info,
      lastUpdate: data.latest_checkpoint_time,
      trackingNumber,
    };
  } catch (error) {
    console.error("TrackingMore GET error:", error.response?.data || error.message);
    return null;
  }
}

// ─── CLAUDE ───────────────────────────────────────────────
async function generateReply(customerMessage, trackingInfo = null, orderInfo = null) {
  let context = "";
  if (orderInfo) context += `[COMMANDE AMAZON]\n${JSON.stringify(orderInfo, null, 2)}\n\n`;
  if (trackingInfo) context += `[SUIVI EN TEMPS RÉEL]\n${JSON.stringify(trackingInfo, null, 2)}\n\n`;
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

// ─── ROUTES ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "BarberCosmetic SAV en ligne ✅",
    transporteurs: ["Colis Privé", "Mondial Relay", "UPS", "Chronopost", "Colissimo"],
    trackingmore: TRACKINGMORE_API_KEY ? "connecté ✅" : "non configuré ❌",
  });
});

app.post("/reply", async (req, res) => {
  try {
    const { message, orderId, trackingNumber, postalCode, carrier } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    let trackingInfo = null;
    if (trackingNumber && carrier) {
      trackingInfo = await getTrackingInfo(trackingNumber, carrier, postalCode);
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
});
