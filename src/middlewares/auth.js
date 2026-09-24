const jwt = require("jsonwebtoken");
const { config } = require("../config");

function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return res.status(401).json({ error: "Não autorizado." });
    try {
        req.user = jwt.verify(token, config.jwtSecret);
        next();
    } catch {
        return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    }
}

function requireAdmin(req, res, next) {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Apenas administradores." });
    next();
}

module.exports = { requireAuth, requireAdmin };
