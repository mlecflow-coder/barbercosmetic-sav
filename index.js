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

  let formattedPostalCode = postalCode;
  if (carrier === "mondialrelay" && postalCode && postalCode.length === 5) {
    formattedPostalCode = postalCode + "0101";
  }

  try {
    const createRes = await axios.post(
      "https://api.trackingmore.com/v4/trackings/create",
      {
        tracking_number: trackingNumber,
        courier_code: carrier,
        tracking_postal_code: formattedPostalCode,
      },
      { headers }
    );
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
    // Tracking existe déjà → récupérer l'ID depuis l'erreur
    const existingId = e.response?.data?.data?.id;
    console.log("ID existant:", existingId);
    if (existingId) {
      try {
       const getRes = await axios.get(
  `https://api.trackingmore.com/v4/trackings`,
  { 
    headers,
    params: { id: existingId }
  }
);
        console.log("GET by ID:", JSON.stringify(getRes.data));
        const data = getRes.data?.data;
        if (data) {
          return {
            status: data.delivery_status,
            carrier: data.courier_name,
            lastEvent: data.latest_event_info,
            lastUpdate: data.latest_checkpoint_time,
            trackingNumber,
          };
        }
      } catch (err) {
        console.error("GET by ID error:", err.response?.data || err.message);
      }
    }
  }
  return null;
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
