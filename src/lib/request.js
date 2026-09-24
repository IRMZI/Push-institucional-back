const crypto = require("crypto");
const { config } = require("../config");

// IP real (app.set("trust proxy") resolve X-Forwarded-For atrás do proxy do Coolify)
function clientIp(req) {
    return (req.ip || "").replace(/^::ffff:/, "") || null;
}

// Tracking first-party anonimizado: guardamos só um hash salgado do IP, nunca o IP.
function ipHash(req) {
    const ip = clientIp(req);
    if (!ip) return null;
    return crypto.createHash("sha256").update(`${config.ipHashSalt}:${ip}`).digest("hex");
}

function userAgent(req) {
    const ua = req.get("user-agent");
    return ua ? ua.slice(0, 500) : null;
}

module.exports = { clientIp, ipHash, userAgent };
