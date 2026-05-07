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

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      carrier VARCHAR(50),
      tracking_number VARCHAR(100),
      postal_code VARCHAR(20),
      status VARCHAR(50) DEFAULT 'en_cours',
      notes TEXT,
      refund_client DECIMAL(10,2),
      refund_packlink DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) NOT NULL,
      customer_message TEXT NOT NULL,
      agent_reply TEXT NOT NULL,
      tracking_status VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS disputes (
      id SERIAL PRIMARY KEY,
      order_id VARCHAR(50) UNIQUE NOT NULL,
      status VARCHAR(50) DEFAULT 'en_attente_docs',
      has_letter BOOLEAN DEFAULT FALSE,
      has_id_doc BOOLEAN DEFAULT FALSE,
      transmitted_packlink BOOLEAN DEFAULT FALSE,
      transmitted_at TIMESTAMP,
      resolution VARCHAR(50),
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("✅ Base de données initialisée");
}

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

async function generateReply(customerMessage, orderInfo = null, history = []) {
  let context = "";
  if (orderInfo) context += `[COMMANDE AMAZON]\n${JSON.stringify(orderInfo, null, 2)}\n\n`;
  if (history.length > 0) {
    context += `[HISTORIQUE DES ÉCHANGES]\n`;
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

app.post("/reply", async (req, res) => {
  try {
    const { message, orderId, carrier, trackingNumber, postalCode, trackingStatus } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    let history = [];
    if (orderId) {
      const histResult = await pool.query(
        "SELECT customer_message, agent_reply FROM messages WHERE order_id = $1 ORDER BY created_at DESC LIMIT 5",
        [orderId]
      );
      history = histResult.rows.reverse();
    }

    let enrichedMessage = message;
    if (trackingStatus) {
      enrichedMessage = `[STATUT CONSTATÉ : ${trackingStatus}]\n[NUMÉRO DE SUIVI : ${trackingNumber || 'N/A'}]\n\n${message}`;
    }

    const orderInfo = orderId ? { orderId, carrier, trackingNumber } : null;
    const reply = await generateReply(enrichedMessage, orderInfo, history);

    if (orderId) {
      await pool.query(`
        INSERT INTO orders (order_id, carrier, tracking_number, postal_code)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (order_id) DO UPDATE SET
          carrier = EXCLUDED.carrier,
          tracking_number = EXCLUDED.tracking_number,
          updated_at = NOW()
      `, [orderId, carrier, trackingNumber, postalCode]);

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

app.get("/orders", async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT o.*, 
        COUNT(m.id) as message_count,
        d.status as dispute_status,
        d.has_letter,
        d.has_id_doc,
        d.transmitted_packlink
      FROM orders o 
      LEFT JOIN messages m ON o.order_id = m.order_id 
      LEFT JOIN disputes d ON o.order_id = d.order_id
    `;
    const params = [];
    if (status && status !== 'all') {
      query += ` WHERE o.status = $1`;
      params.push(status);
    }
    query += ` GROUP BY o.id, d.status, d.has_letter, d.has_id_doc, d.transmitted_packlink ORDER BY o.updated_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await pool.query("SELECT * FROM orders WHERE order_id = $1", [orderId]);
    const messages = await pool.query(
      "SELECT * FROM messages WHERE order_id = $1 ORDER BY created_at ASC",
      [orderId]
    );
    const dispute = await pool.query(
      "SELECT * FROM disputes WHERE order_id = $1",
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

app.put("/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, notes, refundClient, refundPacklink } = req.body;
    await pool.query(`
      UPDATE orders SET 
        status = COALESCE($1, status),
        notes = COALESCE($2, notes),
        refund_client = COALESCE($3, refund_client),
        refund_packlink = COALESCE($4, refund_packlink),
        updated_at = NOW()
      WHERE order_id = $5
    `, [status, notes, refundClient, refundPacklink, orderId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/dispute", async (req, res) => {
  try {
    const { orderId, hasLetter, hasIdDoc, transmittedPacklink, resolution, notes } = req.body;
    await pool.query(`
      INSERT INTO disputes (order_id, has_letter, has_id_doc, transmitted_packlink, transmitted_at, resolution, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (order_id) DO UPDATE SET
        has_letter = EXCLUDED.has_letter,
        has_id_doc = EXCLUDED.has_id_doc,
        transmitted_packlink = EXCLUDED.transmitted_packlink,
        transmitted_at = CASE WHEN EXCLUDED.transmitted_packlink = TRUE AND disputes.transmitted_at IS NULL THEN NOW() ELSE disputes.transmitted_at END,
        resolution = EXCLUDED.resolution,
        notes = EXCLUDED.notes,
        updated_at = NOW()
    `, [orderId, hasLetter, hasIdDoc, transmittedPacklink, transmittedPacklink ? new Date() : null, resolution, notes]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/stats", async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'en_cours' THEN 1 END) as en_cours,
        COUNT(CASE WHEN status = 'cloture_rembourse' THEN 1 END) as cloture_rembourse,
        COUNT(CASE WHEN status = 'cloture_sans_remboursement' THEN 1 END) as cloture_sans_remboursement,
        COUNT(CASE WHEN status = 'litige_ouvert' THEN 1 END) as litige_ouvert,
        COALESCE(SUM(refund_client), 0) as total_rembourse_client,
        COALESCE(SUM(refund_packlink), 0) as total_recupere_packlink
      FROM orders
    `);
    res.json(stats.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`🚀 SAV BarberCosmetic démarré sur le port ${PORT}`);
  await initDB();
});
