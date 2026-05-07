const express = require("express");
const axios = require("axios");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  ANTHROPIC_API_KEY,
  DATABASE_URL,
  PORT = 3000,
} = process.env;

// ─── BASE DE DONNÉES ──────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      customer_name VARCHAR(255),
      carrier VARCHAR(50),
      tracking_number VARCHAR(100),
      postal_code VARCHAR(20),
      status VARCHAR(50) DEFAULT 'en_cours',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      customer_message TEXT NOT NULL,
      agent_reply TEXT NOT NULL,
      tracking_status VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      status VARCHAR(50) DEFAULT 'en_attente_docs',
      has_letter BOOLEAN DEFAULT FALSE,
      has_id_doc BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ Base de données initialisée");
}

// ─── SYSTEM PROMPT ────────────────────────────────────────
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

// ─── CLAUDE ───────────────────────────────────────────────
async function generateReply(customerMessage, orderInfo = null, history = []) {
  let context = "";
  if (orderInfo) context += `[COMMANDE AMAZON]\n${JSON.stringify(orderInfo, null, 2)}\n\n`;
  if (history.length > 0) {
    context += `[HISTORIQUE DES ÉCHANGES PRÉCÉDENTS]\n`;
    history.forEach((h, i) => {
      context += `Échange ${i + 1} :\nClient : ${h.customer_message}\nRéponse : ${h.agent_reply}\n\n`;
    });
  }
  context += `[MESSAGE CLIENT]\n${customerMessage}`;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-5",
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
    database: "PostgreSQL connecté ✅",
  });
});

// Générer une réponse
app.post("/reply", async (req, res) => {
  try {
    const { message, orderId, carrier, trackingNumber, postalCode, trackingStatus } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    // Récupérer l'historique de la commande
    let history = [];
    if (orderId) {
      const histResult = await pool.query(
        "SELECT customer_message, agent_reply FROM messages WHERE order_id = $1 ORDER BY created_at DESC LIMIT 5",
        [orderId]
      );
      history = histResult.rows.reverse();
    }

    // Enrichir le message avec le statut
    let enrichedMessage = message;
    if (trackingStatus) {
      enrichedMessage = `[STATUT CONSTATÉ : ${trackingStatus}]\n[NUMÉRO DE SUIVI : ${trackingNumber || 'N/A'}]\n\n${message}`;
    }

    const orderInfo = orderId ? { orderId, carrier, trackingNumber } : null;
    const reply = await generateReply(enrichedMessage, orderInfo, history);

    // Sauvegarder la commande
    if (orderId) {
      await pool.query(`
        INSERT INTO orders (order_id, carrier, tracking_number, postal_code)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (order_id) DO UPDATE SET
          carrier = EXCLUDED.carrier,
          tracking_number = EXCLUDED.tracking_number,
          updated_at = NOW()
      `, [orderId, carrier, trackingNumber, postalCode]);

      // Sauvegarder le message
      await pool.query(
        "INSERT INTO messages (order_id, customer_message, agent_reply, tracking_status) VALUES ($1, $2, $3, $4)",
        [orderId, message, reply, trackingStatus]
      );
    }

    res.json({ reply });
  } catch (error) {
    console.error("Erreur:", error.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Récupérer l'historique d'une commande
app.get("/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await pool.query("SELECT * FROM orders WHERE order_id = $1", [orderId]);
    const messages = await pool.query(
      "SELECT * FROM messages WHERE order_id = $1 ORDER BY created_at ASC",
      [orderId]
    );
    const dispute = await pool.query(
      "SELECT * FROM disputes WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1",
      [orderId]
    );
    res.json({
      order: order.rows[0] || null,
      messages: messages.rows,
      dispute: dispute.rows[0] || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mettre à jour le statut d'une commande
app.put("/order/:orderId/status", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, notes } = req.body;
    await pool.query(
      "UPDATE orders SET status = $1, notes = $2, updated_at = NOW() WHERE order_id = $3",
      [status, notes, orderId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Créer ou mettre à jour un litige
app.post("/dispute", async (req, res) => {
  try {
    const { orderId, hasLetter, hasIdDoc, notes } = req.body;
    await pool.query(`
      INSERT INTO disputes (order_id, has_letter, has_id_doc, notes)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [orderId, hasLetter, hasIdDoc, notes]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Lister toutes les commandes
app.get("/orders", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT o.*, COUNT(m.id) as message_count FROM orders o LEFT JOIN messages m ON o.order_id = m.order_id GROUP BY o.id ORDER BY o.updated_at DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── DÉMARRAGE ────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 SAV BarberCosmetic démarré sur le port ${PORT}`);
  await initDB();
});
