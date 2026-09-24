const express = require("express");
const sql = require("../db");
const { requireAuth, requireAdmin } = require("../middlewares/auth");
const { z, parse, intId } = require("../lib/validation");
const { hashPassword } = require("../lib/users");

const router = express.Router();
router.use(requireAuth, requireAdmin);

const password = z.string().min(10, "A senha precisa ter ao menos 10 caracteres.").max(200);
const createSchema = z.object({
    username: z.string().trim().toLowerCase().min(3).max(60).regex(/^[a-z0-9._-]+$/, "Use letras, números, ponto, hífen ou _."),
    nome: z.string().trim().max(120).optional().nullable(),
    password,
    role: z.enum(["admin", "membro"]).default("membro"),
});
const updateSchema = z.object({
    nome: z.string().trim().max(120).optional().nullable(),
    password: password.optional(),
    role: z.enum(["admin", "membro"]).optional(),
    ativo: z.boolean().optional(),
});

router.get("/", async (_req, res) => {
    res.json(await sql`SELECT id, username, nome, role, ativo, ultimo_login, criado_em FROM admin_users ORDER BY criado_em`);
});

router.post("/", async (req, res) => {
    const b = parse(createSchema, req.body, res);
    if (!b) return;
    try {
        const rows = await sql`
          INSERT INTO admin_users (username, nome, senha_hash, role)
          VALUES (${b.username}, ${b.nome ?? null}, ${await hashPassword(b.password)}, ${b.role})
          RETURNING id, username, nome, role, ativo, criado_em`;
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "Esse usuário já existe." });
        console.error("Erro ao criar usuário:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

router.patch("/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    const b = parse(updateSchema, req.body, res);
    if (!b) return;
    // Evita o time ficar sem nenhum admin ativo
    if (id === req.user.sub && (b.ativo === false || b.role === "membro")) {
        return res.status(400).json({ error: "Você não pode remover o seu próprio acesso de admin." });
    }
    const hash = b.password ? await hashPassword(b.password) : null;
    const rows = await sql`
      UPDATE admin_users SET
        nome = CASE WHEN ${b.nome !== undefined} THEN ${b.nome ?? null} ELSE nome END,
        senha_hash = COALESCE(${hash}, senha_hash),
        role = COALESCE(${b.role ?? null}, role),
        ativo = COALESCE(${b.ativo ?? null}, ativo)
      WHERE id = ${id}
      RETURNING id, username, nome, role, ativo, ultimo_login, criado_em`;
    if (rows.length === 0) return res.status(404).json({ error: "Usuário não encontrado." });
    res.json(rows[0]);
});

router.delete("/:id", async (req, res) => {
    const id = intId(req.params.id);
    if (!id) return res.status(400).json({ error: "ID inválido." });
    if (id === req.user.sub) return res.status(400).json({ error: "Você não pode excluir o seu próprio usuário." });
    await sql`DELETE FROM admin_users WHERE id = ${id}`;
    res.json({ ok: true });
});

module.exports = router;
