const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  AMAZON_CLIENT_ID,
  AMAZON_CLIENT_SECRET,
  AMAZON_REFRESH_TOKEN,
  ANTHROPIC_API_KEY,
  TRACKINGMORE_API_KEY,
  PORT = 3000,
} = process.env;

const SYSTEM_PROMPT = `Tu es l'assistant SAV officiel de BarberCosmetic, boutique e-commerce sur Amazon.
Tu as accès aux informations de suivi en temps réel via TrackingMore.

TRANSPORTEURS : Colis Privé, Mondial Relay, UPS, Chronopost, Colissimo (France et Europe)

STATUTS EN TRANSIT :
- "transit" → en route, normal sous 2-3 jours
- "pending" → en attente de prise en charge, normal sous 24h
- "undelivered" → tentative échouée, inviter à reprogrammer ou récupérer en point relais
- "delivered" contesté → voir procédure litige
- "exception" → problème détecté, escalader à mlecflow@gmail.com
- Pas de mouvement +5 jours ouvrés → investigation à ouvrir

COLIS LIVRÉ MAIS NON REÇU :
Étape 1 - Vérifications : boîte aux lettres, voisins, point relais, avis de passage
Étape 2 - Demander d'envoyer à mlecflow@gmail.com :
  - Objet : "Contestation livraison - N° de suivi XXXXX"
  - Lettre sur l'honneur (modèle si demandé : "Je soussigné(e) [Prénom Nom], demeurant au [adresse], atteste sur l'honneur ne pas avoir reçu le colis n°[numéro] commandé le [date] sur Amazon. Fait à [ville], le [date]. Signature.")
  - Pièce d'identité (CNI ou passeport)
Ne jamais promettre un remboursement immédiat sur un colis marqué livré sans les documents.

RETARD : excuses sincères + statut TrackingMore + investigation si +5 jours sans mouvement. Pas de code promo sur Amazon.
RETOUR : accepté sous 30 jours, produit non utilisé. Via Amazon ou mlecflow@gmail.com. Remboursement sous 5-7 jours.
PRODUIT DÉFECTUEUX : photo demandée + échange ou remboursement au choix client.

RÈGLES : vouvoyer par défaut, ton chaleureux et professionnel, réponses courtes (4-5 phrases max), toujours une action concrète, jamais promettre de remboursement immédiat sans vérification, contact : mlecflow@gmail.com`;

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

// ─── TRACKINGMORE ─────────────────────────────────────────
async function getTrackingInfo(trackingNumber, carrier, postalCode) {
  try {
    // Essai de création
    const createResponse = await axios.post(
      "https://api.trackingmore.com/v4/trackings/create",
      {
        tracking_number: trackingNumber,
        courier_code: carrier,
        tracking_postal_code: postalCode,
      },
      {
        headers: {
          "Tracking-Api-Key": TRACKINGMORE_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    const created = createResponse.data?.data;
    if (created) return {
      status: created.delivery_status,
      carrier: created.courier_name,
      lastEvent: created.latest_event_info,
      lastUpdate: created.latest_checkpoint_time,
      trackingNumber,
    };
  } catch (e) {
    // Tracking existe déjà — on fait un GET
  }

  try {
    const getResponse = await axios.get(
      `https://api.trackingmore.com/v4/trackings?tracking_numbers=${trackingNumber}&courier_code=${carrier}`,
      {
        headers: {
          "Tracking-Api-Key": TRACKINGMORE_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    const data = getResponse.data?.data?.items?.[0];
    if (!data) return null;
    return {
      status: data.delivery_status,
      carrier: data.courier_name,
      lastEvent: data.latest_event_info,
      lastUpdate: data.latest_checkpoint_time,
      trackingNumber,
    };
  } catch (error) {
    console.error("Erreur TrackingMore:", error.response?.data || error.message);
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
