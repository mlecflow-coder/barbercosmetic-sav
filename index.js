const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  ANTHROPIC_API_KEY,
  PORT = 3000,
} = process.env;

const SYSTEM_PROMPT = `Tu es l'assistant SAV officiel de BarberCosmetic, boutique e-commerce sur Amazon.

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

RETARD : excuses sincères + investigation si +5 jours sans mouvement.
RETOUR : accepté sous 30 jours. Remboursement sous 5-7 jours après réception.
PRODUIT DÉFECTUEUX : photo demandée + échange ou remboursement au choix.

RÈGLES : vouvoyer, ton chaleureux, réponses courtes (4-5 phrases max), contact : mlecflow@gmail.com`;

async function generateReply(customerMessage, orderInfo = null) {
  let context = "";
  if (orderInfo) context += `[COMMANDE AMAZON]\n${JSON.stringify(orderInfo, null, 2)}\n\n`;
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

app.get("/health", (req, res) => {
  res.json({
    status: "BarberCosmetic SAV en ligne ✅",
    transporteurs: ["Colis Privé", "Mondial Relay", "UPS", "Chronopost", "Colissimo"],
  });
});

app.post("/reply", async (req, res) => {
  try {
    const { message, orderId } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    const reply = await generateReply(message, orderId ? { orderId } : null);
    res.json({ reply });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SAV BarberCosmetic démarré sur le port ${PORT}`);
});
