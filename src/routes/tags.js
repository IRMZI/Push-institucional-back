const express = require("express");
const sql = require("../db");
const { requireAuth } = require("../middlewares/auth");
const { z, parse, intId } = require("../lib/validation");

const router = express.Router();
router.use(requireAuth);

const tagSchema = z.object({
    nome: z.string().trim().min(1).max(40),
    cor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida."),
});

router.get("/", async (_req, res) => {
    const tags = await sql`
      SELECT t.id, t.nome, t.cor, t.criado_em,
        (SELECT COUNT(*) FROM lead_tags lt WHERE lt.tag_id = t.id)::int AS leads,
        (SELECT COUNT(*) FROM session_tags st WHERE st.tag_id = t.id)::int AS sessoes
      FROM tags t ORDER BY t.nome`;
    res.json(tags);
});

router.post("/", async (req, res) => {
    const b = parse(tagSchema, req.body, res);
    if (!b) return;
    try {
        const rows = await sql`INSERT INTO tags (nome, cor) VALUES (${b.nome}, ${b.cor.toUpperCase()}) RETURNING *`;
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Já existe uma tag com esse nome." });
        console.error("Erro ao criar tag:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.patch("/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    const b = parse(tagSchema.partial(), req.body, res);
    if (!b) return;
    try {
        const rows = await sql`
          UPDATE tags SET nome = COALESCE(${b.nome ?? null}, nome), cor = COALESCE(${b.cor ? b.cor.toUpperCase() : null}, cor)
          WHERE id = ${id} RETURNING *`;
        if (rows.length === 0) return res.status(404).json({ error: "Tag não encontrada." });
        res.json(rows[0]);
    } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Já existe uma tag com esse nome." });
        console.error("Erro ao editar tag:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.delete("/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    await sql`DELETE FROM tags WHERE id = ${id}`;
    res.json({ ok: true });
});

module.exports = router;
