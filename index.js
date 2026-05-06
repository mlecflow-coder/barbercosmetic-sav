const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

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
- "En transit" / "In transit" → en route, normal sous 2-3 jours
- "En attente" / "Pending" → normal sous 24h
- "En instance" / "Avis de passage" → tentative échouée, inviter à reprogrammer
- "Delivered" / "Livré" → voir procédure litige si contesté
- "Incident" / "Anomalie" → escalader à mlecflow@gmail.com
- Pas de mouvement +5 jours ouvrés → investigation à ouvrir

COLIS LIVRÉ MAIS NON REÇU :
Étape 1 - Vérifications : boîte aux lettres, voisins, point relais, avis de passage
Étape 2 - Si toujours pas trouvé, demander d'envoyer à mlecflow@gmail.com :
  - Objet : "Contestation livraison - N° de suivi XXXXX"
  - Lettre sur l'honneur (modèle si demandé : "Je soussigné(e) [Prénom Nom], demeurant au [adresse], atteste sur l'honneur ne pas avoir reçu le colis n°[numéro] commandé le [date] sur Amazon. Fait à [ville], le [date]. Signature.")
  - Pièce d'identité (CNI ou passeport)
Ne jamais promettre un remboursement immédiat sur un colis marqué livré sans les documents.

RETARD : excuses sincères + statut PacklinkPro + investigation si +5 jours sans mouvement.
RETOUR : accepté sous 30 jours, produit non utilisé. Via Amazon ou mlecflow@gmail.com. Remboursement sous 5-7 jours.
PRODUIT DÉFECTUEUX : photo demandée + échange ou remboursement au choix client.

RÈGLES : vouvoyer par défaut, ton chaleureux et professionnel, réponses courtes (4-5 phrases max), toujours une action concrète, jamais inventer d'informations. Contact : mlecflow@gmail.com`;

// ─── AMAZON ───────────────────────────────────────────────
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

// ─── PACKLINK ──────────────────────────────────────────────
async function searchPacklinkByOrder(orderId) {
  try {
    const response = await axios.get(
      `https://apisandbox.packlink.com/v1/shipments?source=amazon&order_id=${orderId}`,
      {
        headers: {
          "Authorization": PACKLINK_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur PacklinkPro order search:", error.message);
    return null;
  }
}

async function searchPacklinkByName(customerName) {
  try {
    const response = await axios.get(
      `https://apisandbox.packlink.com/v1/shipments?to=${encodeURIComponent(customerName)}`,
      {
        headers: {
          "Authorization": PACKLINK_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur PacklinkPro name search:", error.message);
    return null;
  }
}

async function getPacklinkTracking(shipmentRef) {
  try {
    const response = await axios.get(
      `https://apisandbox.packlink.com/v1/shipments/${shipmentRef}/track`,
      {
        headers: {
          "Authorization": PACKLINK_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Erreur PacklinkPro tracking:", error.message);
    return null;
  }
}

// ─── CLAUDE ───────────────────────────────────────────────
async function generateReply(customerMessage, trackingInfo = null) {
  let context = customerMessage;
  if (trackingInfo) {
    context = `[INFORMATIONS SUIVI PACKLINK]\n${JSON.stringify(trackingInfo, null, 2)}\n\n[MESSAGE CLIENT]\n${customerMessage}`;
  }

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
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
    packlink: PACKLINK_API_KEY ? "connecté ✅" : "non configuré ❌",
  });
});

app.post("/reply", async (req, res) => {
  try {
    const { message, orderId, customerName } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    let trackingInfo = null;

    // Recherche PacklinkPro automatique
    if (orderId) {
      const shipments = await searchPacklinkByOrder(orderId);
      if (shipments && shipments.length > 0) {
        const ref = shipments[0].reference;
        trackingInfo = await getPacklinkTracking(ref);
      }
    } else if (customerName) {
      const shipments = await searchPacklinkByName(customerName);
      if (shipments && shipments.length > 0) {
        const ref = shipments[0].reference;
        trackingInfo = await getPacklinkTracking(ref);
      }
    }

    const reply = await generateReply(message, trackingInfo);
    res.json({ reply, trackingFound: !!trackingInfo });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SAV BarberCosmetic démarré sur le port ${PORT}`);
});
