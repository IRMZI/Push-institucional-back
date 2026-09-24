const express = require("express");
const sql = require("../db");
const { requireAuth } = require("../middlewares/auth");
const { z, parse } = require("../lib/validation");

const router = express.Router();
router.use(requireAuth);

const templatesSchema = z
    .array(
        z.object({
            id: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/),
            titulo: z.string().trim().min(1).max(80),
            texto: z.string().trim().min(1).max(1000),
        })
    )
    .max(20);

// GET /api/settings/whatsapp-templates — mensagens prontas (variáveis: {nome} {primeiro_nome} {empresa} {servicos})
router.get("/whatsapp-templates", async (_req, res) => {
    const rows = await sql`SELECT valor FROM app_settings WHERE chave = 'whatsapp_templates'`;
    res.json(rows[0]?.valor || []);
});

router.put("/whatsapp-templates", async (req, res) => {
    const b = parse(templatesSchema, req.body, res);
    if (!b) return;
    await sql`
      INSERT INTO app_settings (chave, valor, atualizado_em) VALUES ('whatsapp_templates', ${sql.json(b)}, NOW())
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()`;
    res.json(b);
});

module.exports = router;
