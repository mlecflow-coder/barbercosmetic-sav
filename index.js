const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  AMAZON_CLIENT_ID,
  AMAZON_CLIENT_SECRET,
  AMAZON_REFRESH_TOKEN,
  ANTHROPIC_API_KEY,
  PORT = 3000,
} = process.env;

const SYSTEM_PROMPT = `Tu es l'assistant SAV officiel de BarberCosmetic, boutique e-commerce sur Amazon.

TRANSPORTEURS :
- Colis Privé → https://colisprive.fr/ (format : CP + chiffres)
- Mondial Relay → https://www.mondialrelay.fr/ (format : 8 chiffres)
- UPS → https://www.ups.com/fr/fr/home (format : 1Z + lettres/chiffres)
- Chronopost → https://www.chronopost.fr/fr (format : CP + 11 chiffres)
- Colissimo → https://www.laposte.fr/outils/suivre-un-colis (format : 6C, 7R...)

SUIVI :
1. Identifie le transporteur selon le format du numéro de suivi
2. Donne le lien de suivi correspondant
3. Explique le statut en langage clair :
   - "En transit" → en route, normal sous 2-3 jours
   - "En attente" → normal sous 24h
   - "En instance" → tentative de livraison échouée, reprogrammer
   - "Anomalie" → escalader à mlecflow@gmail.com
   - Pas de mouvement +5 jours ouvrés → investigation à ouvrir

COLIS LIVRÉ NON REÇU :
Étape 1 - Vérifications : boîte aux lettres, voisins, point relais, avis de passage
Étape 2 - Si toujours pas trouvé, demander d'envoyer à mlecflow@gmail.com :
  - Objet : "Contestation livraison - N° de suivi XXXXX"
  - Lettre sur l'honneur (modèle si demandé : "Je soussigné(e) [Prénom Nom], demeurant au [adresse], atteste sur l'honneur ne pas avoir reçu le colis n°[numéro] commandé le [date] sur Amazon. Fait à [ville], le [date]. Signature.")
  - Pièce d'identité (CNI ou passeport)
Ne jamais promettre un remboursement immédiat sur un colis marqué livré sans les documents.

RETARD : excuses sincères + lien suivi + investigation si +5 jours ouvrés sans mouvement. Pas de code promo sur Amazon.

RETOUR : accepté sous 30 jours, produit non utilisé. Via Amazon ou mlecflow@gmail.com. Remboursement sous 5-7 jours après réception.

PRODUIT DÉFECTUEUX : excuses + photo demandée + échange ou remboursement au choix client.

RÈGLES : vouvoyer par défaut, ton chaleureux et professionnel, réponses courtes (4-5 phrases max), toujours une action concrète, jamais inventer d'informations. Contact : mlecflow@gmail.com`;

async function getAccessToken() {
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

async function generateReply(customerMessage, orderInfo = "") {
  const context = orderInfo ? `Informations commande : ${orderInfo}\n\nMessage client : ${customerMessage}` : customerMessage;
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

async function processAmazonMessages() {
  try {
    const accessToken = await getAccessToken();
    console.log("✅ Token Amazon récupéré");
    return accessToken;
  } catch (error) {
    console.error("❌ Erreur token Amazon:", error.message);
  }
}

app.get("/health", (req, res) => {
  res.json({ 
    status: "BarberCosmetic SAV en ligne ✅",
    transporteurs: ["Colis Privé", "Mondial Relay", "UPS", "Chronopost", "Colissimo"]
  });
});

app.post("/reply", async (req, res) => {
  try {
    const { message, orderInfo } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });
    const reply = await generateReply(message, orderInfo);
    res.json({ reply });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/amazon/process", async (req, res) => {
  try {
    const token = await processAmazonMessages();
    res.json({ success: true, message: "Connexion Amazon OK", token: token ? "valide" : "erreur" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SAV BarberCosmetic démarré sur le port ${PORT}`);
});
