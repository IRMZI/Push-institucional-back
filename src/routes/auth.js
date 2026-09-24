const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sql = require("../db");
const { config } = require("../config");
const { loginLimiter } = require("../middlewares/limits");
const { requireAuth } = require("../middlewares/auth");
const { z, parse } = require("../lib/validation");

const router = express.Router();

// Hash fixo usado quando o usuário não existe — mantém o tempo de resposta constante
const DUMMY_HASH = bcrypt.hashSync("push-dummy-password", 10);

const loginSchema = z.object({
    username: z.string().trim().min(1).max(60),
    password: z.string().min(1).max(200),
});

// POST /api/auth/login
router.post("/login", loginLimiter, async (req, res) => {
    const body = parse(loginSchema, req.body, res);
    if (!body) return;

    try {
        const rows = await sql`
          SELECT id, username, nome, senha_hash, role, ativo
          FROM admin_users WHERE LOWER(username) = LOWER(${body.username})`;
        const user = rows[0];
        // Sempre roda o bcrypt, exista ou não o usuário (evita enumeração por timing)
        const ok = await bcrypt.compare(body.password, user ? user.senha_hash : DUMMY_HASH);
        if (!user || !ok || !user.ativo) {
            return res.status(401).json({ error: "Usuário ou senha incorretos." });
        }

        await sql`UPDATE admin_users SET ultimo_login = NOW() WHERE id = ${user.id}`;
        const token = jwt.sign({ sub: user.id, username: user.username, nome: user.nome, role: user.role }, config.jwtSecret, {
            expiresIn: config.jwtExpiresIn,
        });
        const { exp } = jwt.decode(token);
        res.json({ token, expiresAt: exp * 1000, user: { id: user.id, username: user.username, nome: user.nome, role: user.role } });
    } catch (err) {
        console.error("Erro no login:", err);
        res.status(500).json({ error: "Erro interno." });
    }
});

// GET /api/auth/me — valida o token e devolve o usuário atual
router.get("/me", requireAuth, async (req, res) => {
    const rows = await sql`SELECT id, username, nome, role, ativo FROM admin_users WHERE id = ${req.user.sub}`;
    if (!rows[0] || !rows[0].ativo) return res.status(401).json({ error: "Usuário desativado." });
    res.json(rows[0]);
});

module.exports = router;
