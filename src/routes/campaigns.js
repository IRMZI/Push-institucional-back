const express = require("express");
const sql = require("../db");
const { requireAuth } = require("../middlewares/auth");
const { z, parse, intId } = require("../lib/validation");

const router = express.Router();
router.use(requireAuth);

const DATE = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(""), z.null()]).transform((v) => v || null);

const schema = z
    .object({
        nome: z.string().trim().min(1).max(120),
        utm_campaign: z.string().trim().min(1).max(255),
        canal: z.string().trim().max(40).optional().nullable(),
        investimento: z.coerce.number().min(0).max(100_000_000),
        inicio: DATE.optional(),
        fim: DATE.optional(),
        ativo: z.boolean().optional(),
    })
    .refine((c) => !c.inicio || !c.fim || c.inicio <= c.fim, { message: "A data final deve ser depois da inicial.", path: ["fim"] });

router.get("/", async (_req, res) => {
    const rows = await sql`
      SELECT c.id, c.nome, c.utm_campaign, c.canal, c.investimento::float AS investimento,
        to_char(c.inicio, 'YYYY-MM-DD') AS inicio, to_char(c.fim, 'YYYY-MM-DD') AS fim, c.ativo, c.criado_em,
        (SELECT COUNT(*)::int FROM leads l WHERE LOWER(l.utm_campaign) = LOWER(c.utm_campaign) AND l.deletado_em IS NULL) AS leads
      FROM campaigns c ORDER BY c.ativo DESC, c.criado_em DESC`;
    res.json(rows.map((c) => ({ ...c, cpl: c.leads > 0 ? c.investimento / c.leads : null })));
});

router.post("/", async (req, res) => {
    const b = parse(schema, req.body, res);
    if (!b) return;
    try {
        const rows = await sql`
          INSERT INTO campaigns (nome, utm_campaign, canal, investimento, inicio, fim, ativo)
          VALUES (${b.nome}, ${b.utm_campaign}, ${b.canal ?? null}, ${b.investimento}, ${b.inicio ?? null}, ${b.fim ?? null}, ${b.ativo ?? true})
          RETURNING id`;
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Já existe uma campanha com esse utm_campaign." });
        console.error("Erro ao criar campanha:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.put("/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    const b = parse(schema, req.body, res);
    if (!b) return;
    try {
        const rows = await sql`
          UPDATE campaigns SET nome = ${b.nome}, utm_campaign = ${b.utm_campaign}, canal = ${b.canal ?? null},
            investimento = ${b.investimento}, inicio = ${b.inicio ?? null}, fim = ${b.fim ?? null}, ativo = ${b.ativo ?? true}
          WHERE id = ${id} RETURNING id`;
        if (rows.length === 0) return res.status(404).json({ error: "Campanha não encontrada." });
        res.json(rows[0]);
    } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Já existe uma campanha com esse utm_campaign." });
        console.error("Erro ao editar campanha:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.delete("/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    await sql`DELETE FROM campaigns WHERE id = ${id}`;
    res.json({ ok: true });
});

module.exports = router;
