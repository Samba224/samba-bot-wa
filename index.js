const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    delay, 
    fetchLatestBaileysVersion,
    Browsers
} = require("@whiskeysockets/baileys");
const pino = require('pino');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════
// 🔒 CONFIGURATION SÉCURISÉE
// ═══════════════════════════════════════════════════════════════

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

if (!GROQ_API_KEY) {
    console.error("❌ ERREUR: GROQ_API_KEY manquante dans le fichier .env");
    console.log("\n📋 Créez un fichier .env avec:");
    console.log("GROQ_API_KEY=votre_clé_api_ici\n");
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// 🎨 CONFIGURATION & CONSTANTES
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
    spam: {
        threshold: 5,
        timeWindow: 10000,
        maxWarnings: 3
    },
    files: {
        phone: './phone.txt',
        pairingCode: './pairing_code.txt',
        logs: './logs',
        media: './media',
        data: './data',
        userStats: './data/user_stats.json',
        groupStats: './data/group_stats.json',
        warnings: './data/warnings.json',
        statusLimits: './data/status_limits.json'
    },
    reconnect: {
        delay: 5000,
        maxAttempts: 5
    },
    messageTracking: {
        timeWindow: 24 * 60 * 60 * 1000,
        cleanupInterval: 60 * 60 * 1000
    },
    statusMention: {
        maxPerDay: 3,
        timeWindow: 24 * 60 * 60 * 1000
    },
    rateLimit: {
        ai: {
            maxRequests: 10,
            timeWindow: 60 * 60 * 1000, // 1 heure
            cooldown: 5000 // 5 secondes entre requêtes
        },
        commands: {
            maxRequests: 30,
            timeWindow: 60 * 1000 // 1 minute
        }
    }
};

// Stockage en mémoire
const userMessages = new Map();
const warnings = new Map();
const groupStats = new Map();
const commandLogs = new Map();
const userMessageHistory = new Map();
const userMentionHistory = new Map();
const statusMentionLimits = new Map();
const userStatusMentions = new Map();
const userReadReceipts = new Map();
const userReplies = new Map();
const userMediaSent = new Map();
const aiRateLimits = new Map();
const commandRateLimits = new Map();
const aiCooldowns = new Map();

let phoneNumber = null;
let pairingCode = null;
let reconnectAttempts = 0;

const logger = pino({ level: 'silent' });

// Patterns de détection
const PATTERNS = {
    link: /(https?:\/\/|www\.)[^\s]+|wa\.me\/[^\s]+|t\.me\/[^\s]+/gi,
    phone: /(\+?\d{10,15})/,
    badWords: /\b(spam|scam|hack)\b/gi
};

// ═══════════════════════════════════════════════════════════════
// 🎨 DESIGN SYSTEM
// ═══════════════════════════════════════════════════════════════

const EMOJIS = {
    success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️',
    crown: '👑', user: '👤', group: '👥', robot: '🤖',
    star: '⭐', fire: '🔥', rocket: '🚀', shield: '🛡️',
    bell: '🔔', chart: '📊', gift: '🎁', wave: '👋',
    sparkle: '✨', clock: '⏰', lock: '🔒'
};

const DESIGN = {
    header: (title) => `
╔═══════════════════════════════════╗
║  ${EMOJIS.star} ${title.toUpperCase().padEnd(30)} ${EMOJIS.star}  ║
╚═══════════════════════════════════╝`,
    
    box: (content) => `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
${content}
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`,
    
    divider: '━'.repeat(35),
    
    footer: () => `\n${EMOJIS.robot} *BOT SAMBA V3.0* ${EMOJIS.fire}\n_Créé avec ${EMOJIS.sparkle} par SAMBA_`,
    
    progress: (current, total) => {
        const percent = Math.round((current / total) * 100);
        const filled = Math.floor(percent / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        return `[${bar}] ${percent}%`;
    }
};

// ═══════════════════════════════════════════════════════════════
// 💾 SYSTÈME DE PERSISTANCE DES DONNÉES
// ═══════════════════════════════════════════════════════════════

class DataPersistence {
    static async ensureDirectories() {
        for (const dir of Object.values(CONFIG.files)) {
            if (dir.includes('.')) continue;
            try {
                await fs.mkdir(dir, { recursive: true });
            } catch (err) {
                console.error(`Erreur création ${dir}:`, err.message);
            }
        }
    }

    static async saveData(filename, data) {
        try {
            const jsonData = JSON.stringify(data, (key, value) => {
                if (value instanceof Map) {
                    return {
                        dataType: 'Map',
                        value: Array.from(value.entries())
                    };
                }
                return value;
            }, 2);
            await fs.writeFile(filename, jsonData, 'utf-8');
        } catch (err) {
            console.error(`Erreur sauvegarde ${filename}:`, err.message);
        }
    }

    static async loadData(filename, defaultValue = {}) {
        try {
            const data = await fs.readFile(filename, 'utf-8');
            return JSON.parse(data, (key, value) => {
                if (typeof value === 'object' && value !== null) {
                    if (value.dataType === 'Map') {
                        return new Map(value.value);
                    }
                }
                return value;
            });
        } catch {
            return defaultValue;
        }
    }

    static async saveAllData() {
        await Promise.all([
            this.saveData(CONFIG.files.userStats, {
                messages: Array.from(userMessageHistory.entries()),
                mentions: Array.from(userMentionHistory.entries()),
                replies: Array.from(userReplies.entries()),
                media: Array.from(userMediaSent.entries()),
                reads: Array.from(userReadReceipts.entries())
            }),
            this.saveData(CONFIG.files.groupStats, Array.from(groupStats.entries())),
            this.saveData(CONFIG.files.warnings, Array.from(warnings.entries())),
            this.saveData(CONFIG.files.statusLimits, {
                limits: Array.from(statusMentionLimits.entries()),
                mentions: Array.from(userStatusMentions.entries())
            })
        ]);
    }

    static async loadAllData() {
        const [userStats, groupStatsData, warningsData, statusData] = await Promise.all([
            this.loadData(CONFIG.files.userStats, {}),
            this.loadData(CONFIG.files.groupStats, []),
            this.loadData(CONFIG.files.warnings, []),
            this.loadData(CONFIG.files.statusLimits, {})
        ]);

        // Restaurer les Maps
        if (userStats.messages) {
            userStats.messages.forEach(([k, v]) => userMessageHistory.set(k, v));
        }
        if (userStats.mentions) {
            userStats.mentions.forEach(([k, v]) => userMentionHistory.set(k, v));
        }
        if (userStats.replies) {
            userStats.replies.forEach(([k, v]) => userReplies.set(k, v));
        }
        if (userStats.media) {
            userStats.media.forEach(([k, v]) => userMediaSent.set(k, v));
        }
        if (userStats.reads) {
            userStats.reads.forEach(([k, v]) => userReadReceipts.set(k, v));
        }
        
        groupStatsData.forEach(([k, v]) => groupStats.set(k, v));
        warningsData.forEach(([k, v]) => warnings.set(k, v));
        
        if (statusData.limits) {
            statusData.limits.forEach(([k, v]) => statusMentionLimits.set(k, v));
        }
        if (statusData.mentions) {
            statusData.mentions.forEach(([k, v]) => userStatusMentions.set(k, v));
        }

        console.log(`${EMOJIS.success} Données restaurées depuis le disque`);
    }
}

// Sauvegarde automatique toutes les 5 minutes
setInterval(() => {
    DataPersistence.saveAllData().catch(err => 
        console.error("Erreur sauvegarde auto:", err.message)
    );
}, 5 * 60 * 1000);

// Sauvegarde à la fermeture
process.on('SIGINT', async () => {
    console.log('\n\n🛑 Arrêt du bot...');
    await DataPersistence.saveAllData();
    console.log(`${EMOJIS.success} Données sauvegardées`);
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await DataPersistence.saveAllData();
    process.exit(0);
});

// ═══════════════════════════════════════════════════════════════
// 🚦 SYSTÈME DE RATE LIMITING
// ═══════════════════════════════════════════════════════════════

class RateLimiter {
    static checkAIRateLimit(userId) {
        const now = Date.now();
        const key = `ai_${userId}`;
        
        if (!aiRateLimits.has(key)) {
            aiRateLimits.set(key, []);
        }
        
        const requests = aiRateLimits.get(key);
        const cutoff = now - CONFIG.rateLimit.ai.timeWindow;
        const recentRequests = requests.filter(t => t > cutoff);
        
        aiRateLimits.set(key, recentRequests);
        
        if (recentRequests.length >= CONFIG.rateLimit.ai.maxRequests) {
            const oldestRequest = recentRequests[0];
            const timeLeft = Math.ceil((oldestRequest + CONFIG.rateLimit.ai.timeWindow - now) / 60000);
            return { allowed: false, timeLeft };
        }
        
        return { allowed: true, remaining: CONFIG.rateLimit.ai.maxRequests - recentRequests.length };
    }

    static checkAICooldown(userId) {
        const now = Date.now();
        const lastRequest = aiCooldowns.get(userId);
        
        if (lastRequest && (now - lastRequest) < CONFIG.rateLimit.ai.cooldown) {
            const timeLeft = Math.ceil((CONFIG.rateLimit.ai.cooldown - (now - lastRequest)) / 1000);
            return { allowed: false, timeLeft };
        }
        
        return { allowed: true };
    }

    static recordAIRequest(userId) {
        const now = Date.now();
        const key = `ai_${userId}`;
        
        if (!aiRateLimits.has(key)) {
            aiRateLimits.set(key, []);
        }
        
        aiRateLimits.get(key).push(now);
        aiCooldowns.set(userId, now);
    }

    static checkCommandRateLimit(userId) {
        const now = Date.now();
        const key = `cmd_${userId}`;
        
        if (!commandRateLimits.has(key)) {
            commandRateLimits.set(key, []);
        }
        
        const requests = commandRateLimits.get(key);
        const cutoff = now - CONFIG.rateLimit.commands.timeWindow;
        const recentRequests = requests.filter(t => t > cutoff);
        
        commandRateLimits.set(key, recentRequests);
        
        if (recentRequests.length >= CONFIG.rateLimit.commands.maxRequests) {
            return { allowed: false };
        }
        
        requests.push(now);
        return { allowed: true };
    }
}

// ═══════════════════════════════════════════════════════════════
// 🤖 GROQ AI - VERSION SÉCURISÉE
// ═══════════════════════════════════════════════════════════════

async function askGroqAI(question, context = "") {
    try {
        const response = await fetch(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    {
                        role: "system",
                        content: "Tu es SAMBA AI, un assistant intelligent intégré dans un bot WhatsApp. Tu réponds de manière claire, concise et utile en français. Tu es sympathique et professionnel. Limite tes réponses à 500 caractères maximum pour WhatsApp."
                    },
                    {
                        role: "user",
                        content: context ? `Contexte: ${context}\n\nQuestion: ${question}` : question
                    }
                ],
                temperature: 0.7,
                max_tokens: 500,
                top_p: 1,
                stream: false
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.error("Erreur Groq API:", error);
            return null;
        }

        const data = await response.json();
        return data.choices[0]?.message?.content || null;
    } catch (error) {
        console.error("Erreur lors de l'appel à Groq AI:", error.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// 🔧 FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════════

async function loadTargetPhone() {
    try {
        const content = await fs.readFile(CONFIG.files.phone, 'utf-8');
        const cleaned = content.trim().replace(/\D/g, '');
        if (cleaned && cleaned.length >= 9) {
            phoneNumber = cleaned;
            console.log(`${EMOJIS.success} Numéro détecté : +${phoneNumber}`);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

async function requestPairingCode(sock) {
    if (!phoneNumber) return false;
    try {
        console.log(`\n${EMOJIS.bell} Demande code pour +${phoneNumber}...`);
        pairingCode = await sock.requestPairingCode(phoneNumber);
        
        console.log("\n" + "═".repeat(60));
        console.log(`     ${EMOJIS.star} CODE DE JUMELAGE : ${pairingCode} ${EMOJIS.star}`);
        console.log("═".repeat(60) + "\n");
        
        await fs.writeFile(CONFIG.files.pairingCode, pairingCode);
        return true;
    } catch (err) {
        console.error(`${EMOJIS.error} Échec pairing:`, err.message);
        return false;
    }
}

function logCommand(command, sender, groupId) {
    const key = `${groupId}_${command}`;
    const count = commandLogs.get(key) || 0;
    commandLogs.set(key, count + 1);
}

async function updateGroupStats(groupId, action) {
    if (!groupStats.has(groupId)) {
        groupStats.set(groupId, {
            messages: 0, commands: 0, warnings: 0,
            kicks: 0, joins: 0, leaves: 0
        });
    }
    const stats = groupStats.get(groupId);
    stats[action] = (stats[action] || 0) + 1;
}

// ═══════════════════════════════════════════════════════════════
// 📊 TRACKING DES MESSAGES
// ═══════════════════════════════════════════════════════════════

function trackUserMessage(groupId, userId, timestamp) {
    const key = `${groupId}_${userId}`;
    if (!userMessageHistory.has(key)) {
        userMessageHistory.set(key, []);
    }
    userMessageHistory.get(key).push(timestamp);
    
    const history = userMessageHistory.get(key);
    const cutoff = timestamp - CONFIG.messageTracking.timeWindow;
    userMessageHistory.set(key, history.filter(t => t > cutoff));
}

function trackUserMention(groupId, userId, timestamp) {
    const key = `${groupId}_${userId}`;
    if (!userMentionHistory.has(key)) {
        userMentionHistory.set(key, []);
    }
    userMentionHistory.get(key).push(timestamp);
    
    const history = userMentionHistory.get(key);
    const cutoff = timestamp - CONFIG.messageTracking.timeWindow;
    userMentionHistory.set(key, history.filter(t => t > cutoff));
}

function trackUserReply(groupId, userId, timestamp) {
    const key = `${groupId}_${userId}`;
    if (!userReplies.has(key)) {
        userReplies.set(key, []);
    }
    userReplies.get(key).push(timestamp);
    
    const history = userReplies.get(key);
    const cutoff = timestamp - CONFIG.messageTracking.timeWindow;
    userReplies.set(key, history.filter(t => t > cutoff));
}

function trackUserMedia(groupId, userId, mediaType, timestamp) {
    const key = `${groupId}_${userId}`;
    if (!userMediaSent.has(key)) {
        userMediaSent.set(key, { image: [], video: [], audio: [], document: [] });
    }
    const media = userMediaSent.get(key);
    if (media[mediaType]) {
        media[mediaType].push(timestamp);
        const cutoff = timestamp - CONFIG.messageTracking.timeWindow;
        media[mediaType] = media[mediaType].filter(t => t > cutoff);
    }
}

function getUserMessageCount(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const now = Date.now();
    const cutoff = now - CONFIG.messageTracking.timeWindow;
    const history = userMessageHistory.get(key) || [];
    return history.filter(t => t > cutoff).length;
}

function getUserMentionCount(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const now = Date.now();
    const cutoff = now - CONFIG.messageTracking.timeWindow;
    const history = userMentionHistory.get(key) || [];
    return history.filter(t => t > cutoff).length;
}

function getUserReplyCount(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const now = Date.now();
    const cutoff = now - CONFIG.messageTracking.timeWindow;
    const history = userReplies.get(key) || [];
    return history.filter(t => t > cutoff).length;
}

function getUserMediaCount(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const media = userMediaSent.get(key) || { image: [], video: [], audio: [], document: [] };
    const now = Date.now();
    const cutoff = now - CONFIG.messageTracking.timeWindow;
    
    return {
        image: media.image?.filter(t => t > cutoff).length || 0,
        video: media.video?.filter(t => t > cutoff).length || 0,
        audio: media.audio?.filter(t => t > cutoff).length || 0,
        document: media.document?.filter(t => t > cutoff).length || 0
    };
}

// ═══════════════════════════════════════════════════════════════
// 📱 GESTION DES MENTIONS STATUT
// ═══════════════════════════════════════════════════════════════

function isStatusMentionLimitEnabled(groupId) {
    return statusMentionLimits.get(groupId) || false;
}

function setStatusMentionLimit(groupId, enabled) {
    statusMentionLimits.set(groupId, enabled);
}

function trackStatusMention(groupId, userId, timestamp) {
    const key = `${groupId}_${userId}`;
    if (!userStatusMentions.has(key)) {
        userStatusMentions.set(key, []);
    }
    userStatusMentions.get(key).push(timestamp);
    
    const history = userStatusMentions.get(key);
    const cutoff = timestamp - CONFIG.statusMention.timeWindow;
    userStatusMentions.set(key, history.filter(t => t > cutoff));
}

function getStatusMentionCount(groupId, userId) {
    const key = `${groupId}_${userId}`;
    const now = Date.now();
    const cutoff = now - CONFIG.statusMention.timeWindow;
    const history = userStatusMentions.get(key) || [];
    return history.filter(t => t > cutoff).length;
}

function canMentionInStatus(groupId, userId) {
    if (!isStatusMentionLimitEnabled(groupId)) return true;
    const count = getStatusMentionCount(groupId, userId);
    return count < CONFIG.statusMention.maxPerDay;
}

// ═══════════════════════════════════════════════════════════════
// 🧹 NETTOYAGE AUTOMATIQUE
// ═══════════════════════════════════════════════════════════════

function cleanupOldData() {
    const now = Date.now();
    const cutoff = now - CONFIG.messageTracking.timeWindow;
    
    for (const [key, history] of userMessageHistory.entries()) {
        const filtered = history.filter(t => t > cutoff);
        if (filtered.length === 0) {
            userMessageHistory.delete(key);
        } else {
            userMessageHistory.set(key, filtered);
        }
    }
    
    for (const [key, history] of userMentionHistory.entries()) {
        const filtered = history.filter(t => t > cutoff);
        if (filtered.length === 0) {
            userMentionHistory.delete(key);
        } else {
            userMentionHistory.set(key, filtered);
        }
    }
    
    for (const [key, history] of userStatusMentions.entries()) {
        const filtered = history.filter(t => t > cutoff);
        if (filtered.length === 0) {
            userStatusMentions.delete(key);
        } else {
            userStatusMentions.set(key, filtered);
        }
    }
    
    console.log(`${EMOJIS.success} Nettoyage automatique effectué`);
}

setInterval(cleanupOldData, CONFIG.messageTracking.cleanupInterval);

// ═══════════════════════════════════════════════════════════════
// 🎯 FONCTIONNALITÉS
// ═══════════════════════════════════════════════════════════════

async function getGroupStats(groupId) {
    const stats = groupStats.get(groupId) || {};
    return DESIGN.box(`
┃ ${EMOJIS.chart} *STATISTIQUES DU GROUPE*
┃ 
┃ 📨 Messages : ${stats.messages || 0}
┃ ⚡ Commandes : ${stats.commands || 0}
┃ ⚠️ Avertissements : ${stats.warnings || 0}
┃ 🚫 Exclusions : ${stats.kicks || 0}
┃ ${EMOJIS.wave} Arrivées : ${stats.joins || 0}
┃ 👋 Départs : ${stats.leaves || 0}
`) + DESIGN.footer();
}

async function generateWelcomeCard(name, groupName) {
    return `${DESIGN.header('BIENVENUE')}

${EMOJIS.gift} *Salut @${name} !*

Tu viens de rejoindre :
${EMOJIS.group} *${groupName}*

${DESIGN.divider}

${EMOJIS.info} *INFORMATIONS UTILES*
• Tape *!help* pour les commandes
• Respecte les règles du groupe
• ${EMOJIS.shield} Anti-spam & Anti-liens actifs
• Sois sympa avec tout le monde !

${DESIGN.divider}

${EMOJIS.rocket} *Passe un excellent moment !*
${DESIGN.footer()}`;
}

async function generateGoodbyeCard(name, groupName) {
    return `${DESIGN.box(`
┃ ${EMOJIS.wave} *AU REVOIR*
┃
┃ @${name} a quitté le groupe
┃ ${groupName}
┃
┃ On espère te revoir bientôt ! 💙
`)}${DESIGN.footer()}`;
}

// ═══════════════════════════════════════════════════════════════
// 🎖️ FONCTION TOP MEMBRES (VERSION UNIQUE)
// ═══════════════════════════════════════════════════════════════

async function generateTopMembers(groupId, groupMetadata, limit = 10) {
    const participants = groupMetadata.participants;
    
    const memberActivity = [];
    for (const p of participants) {
        const msgCount = getUserMessageCount(groupId, p.id);
        if (msgCount > 0) {
            memberActivity.push({
                id: p.id,
                name: p.id.split('@')[0],
                count: msgCount,
                isAdmin: p.admin
            });
        }
    }
    
    memberActivity.sort((a, b) => b.count - a.count);
    const topMembers = memberActivity.slice(0, limit);
    
    if (topMembers.length === 0) {
        return null;
    }
    
    let topMsg = DESIGN.header(`TOP ${limit} MEMBRES ACTIFS`) + `\n\n${EMOJIS.chart} *Classement 24H*\n\n`;
    const mentions = [];
    const medals = ['🥇', '🥈', '🥉'];
    
    topMembers.forEach((member, index) => {
        const medal = medals[index] || `${index + 1}️⃣`;
        const crown = member.isAdmin ? ` ${EMOJIS.crown}` : '';
        topMsg += `${medal} @${member.name}${crown}\n`;
        topMsg += `   ${EMOJIS.fire} ${member.count} messages\n`;
        topMsg += `   ${DESIGN.progress(Math.min(member.count, 100), 100)}\n\n`;
        mentions.push(member.id);
    });
    
    topMsg += `${DESIGN.divider}\n${EMOJIS.info} Total : ${memberActivity.length} membre(s) actif(s)\n\n${DESIGN.footer()}`;
    
    return { text: topMsg, mentions };
}

// ═══════════════════════════════════════════════════════════════
// 📊 FONCTION RAPPORT COMPLET (VERSION UNIQUE)
// ═══════════════════════════════════════════════════════════════

async function generateFullReport(groupId, groupMetadata) {
    const participants = groupMetadata.participants;
    
    let report = DESIGN.header('RAPPORT ACTIVITÉ COMPLET') + `\n\n`;
    report += `${EMOJIS.group} *Groupe :* ${groupMetadata.subject}\n`;
    report += `${EMOJIS.user} *Membres :* ${participants.length}\n`;
    report += `📅 *Période :* Dernières 24 heures\n\n`;
    report += `${DESIGN.divider}\n\n`;
    
    const allStats = [];
    
    for (const p of participants) {
        const userId = p.id;
        const name = userId.split('@')[0];
        
        const msgCount = getUserMessageCount(groupId, userId);
        const mentionCount = getUserMentionCount(groupId, userId);
        const replyCount = getUserReplyCount(groupId, userId);
        const mediaCount = getUserMediaCount(groupId, userId);
        const totalMedia = mediaCount.image + mediaCount.video + mediaCount.audio + mediaCount.document;
        
        const activityScore = msgCount * 2 + replyCount * 3 + totalMedia * 1.5;
        
        allStats.push({
            id: userId,
            name,
            isAdmin: p.admin,
            messages: msgCount,
            mentions: mentionCount,
            replies: replyCount,
            media: mediaCount,
            totalMedia,
            activityScore
        });
    }
    
    allStats.sort((a, b) => b.activityScore - a.activityScore);
    const activeMembers = allStats.filter(s => s.messages > 0);
    const inactiveCount = allStats.length - activeMembers.length;
    
    if (activeMembers.length === 0) {
        return null;
    }
    
    report += `${EMOJIS.fire} *MEMBRES ACTIFS : ${activeMembers.length}*\n`;
    report += `😴 *MEMBRES INACTIFS : ${inactiveCount}*\n\n`;
    report += `${DESIGN.divider}\n\n`;
    
    const mentions = [];
    
    activeMembers.forEach((stat, index) => {
        const rank = index + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
        const crown = stat.isAdmin ? ` ${EMOJIS.crown}` : '';
        
        report += `${medal} *@${stat.name}*${crown}\n`;
        report += `├ 💬 Messages : ${stat.messages}\n`;
        report += `├ 💭 Réponses : ${stat.replies}\n`;
        report += `├ 🏷️ Identifié : ${stat.mentions} fois\n`;
        
        if (stat.totalMedia > 0) {
            report += `├ 📎 Médias : ${stat.totalMedia}`;
            const mediaDetails = [];
            if (stat.media.image > 0) mediaDetails.push(`📷${stat.media.image}`);
            if (stat.media.video > 0) mediaDetails.push(`🎥${stat.media.video}`);
            if (stat.media.audio > 0) mediaDetails.push(`🎵${stat.media.audio}`);
            if (stat.media.document > 0) mediaDetails.push(`📄${stat.media.document}`);
            if (mediaDetails.length > 0) report += ` (${mediaDetails.join(' ')})`;
            report += `\n`;
        }
        
        let evaluation = '';
        if (stat.messages < 5) evaluation = '📉 Peu actif';
        else if (stat.messages < 20) evaluation = '📊 Actif';
        else if (stat.messages < 50) evaluation = '🔥 Très actif';
        else evaluation = '⚡ Hyperactif';
        
        report += `└ ${evaluation}\n\n`;
        mentions.push(stat.id);
    });
    
    const totalMessages = activeMembers.reduce((sum, s) => sum + s.messages, 0);
    const totalReplies = activeMembers.reduce((sum, s) => sum + s.replies, 0);
    const totalMedia = activeMembers.reduce((sum, s) => sum + s.totalMedia, 0);
    const avgMessages = (totalMessages / activeMembers.length).toFixed(1);
    
    report += `${DESIGN.divider}\n\n`;
    report += `${EMOJIS.chart} *RÉSUMÉ GLOBAL*\n\n`;
    report += `📨 Total messages : ${totalMessages}\n`;
    report += `💭 Total réponses : ${totalReplies}\n`;
    report += `📎 Total médias : ${totalMedia}\n`;
    report += `📊 Moyenne/membre : ${avgMessages} msgs\n\n`;
    
    report += `${DESIGN.divider}\n\n`;
    report += `🏆 *PODIUM*\n\n`;
    if (activeMembers[0]) {
        report += `🥇 @${activeMembers[0].name} - ${activeMembers[0].messages} msgs\n`;
    }
    if (activeMembers[1]) {
        report += `🥈 @${activeMembers[1].name} - ${activeMembers[1].messages} msgs\n`;
    }
    if (activeMembers[2]) {
        report += `🥉 @${activeMembers[2].name} - ${activeMembers[2].messages} msgs\n`;
    }
    
    report += `\n${DESIGN.footer()}`;
    
    return { report, mentions };
}

// ═══════════════════════════════════════════════════════════════
// 🤖 DÉMARRAGE DU BOT
// ═══════════════════════════════════════════════════════════════

async function startBot() {
    await DataPersistence.ensureDirectories();
    await DataPersistence.loadAllData();
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    console.log(`${EMOJIS.rocket} Initialisation BOT SAMBA V3.0...`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS("Chrome", "122.0"),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: true,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    let pairingAttempted = false;
    let isAuthenticated = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !pairingAttempted) {
            console.log(`\n${EMOJIS.info} QR CODE DISPONIBLE DANS LES LOGS`);
            console.log(qr);
            
            pairingAttempted = true;
            const loaded = await loadTargetPhone();
            if (loaded) {
                await delay(2000);
                await requestPairingCode(sock);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`${EMOJIS.warning} CONNEXION FERMÉE - Code: ${statusCode || 'inconnu'}`);
            
            if (statusCode === 440) {
                console.log(`\n${EMOJIS.error} ERREUR 440 : CONNEXION MULTIPLE`);
                console.log(`${EMOJIS.info} Ferme tous les WhatsApp Web actifs\n`);
                return;
            }
            
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(`${EMOJIS.error} SESSION INVALIDE - Supprime 'auth_info' et redémarre`);
                isAuthenticated = false;
                return;
            }
            
            if (shouldReconnect && reconnectAttempts < CONFIG.reconnect.maxAttempts) {
                reconnectAttempts++;
                const delayTime = CONFIG.reconnect.delay * reconnectAttempts;
                console.log(`${EMOJIS.info} Reconnexion ${reconnectAttempts}/${CONFIG.reconnect.maxAttempts} dans ${delayTime/1000}s...`);
                setTimeout(() => startBot(), delayTime);
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0;
            isAuthenticated = true;
            pairingAttempted = false;
            
            console.log(`\n${'═'.repeat(50)}`);
            console.log(`${EMOJIS.success} BOT SAMBA V3.0 CONNECTÉ ${EMOJIS.fire}`);
            console.log(`${'═'.repeat(50)}`);
            console.log(`${EMOJIS.lock} Clé API sécurisée`);
            console.log(`${EMOJIS.shield} Protections actives`);
            console.log(`💾 Persistance des données activée`);
            console.log(`🚦 Rate limiting activé`);
            console.log(`${'═'.repeat(50)}\n`);
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // 👥 GESTION DES PARTICIPANTS
    // ═══════════════════════════════════════════════════════════════

    sock.ev.on('group-participants.update', async (anu) => {
        if (anu.action === 'add') {
            try {
                await delay(3000);
                const metadata = await sock.groupMetadata(anu.id);
                await updateGroupStats(anu.id, 'joins');
                
                for (let participant of anu.participants) {
                    let jid = typeof participant === 'string' ? participant : participant.id || participant.phoneNumber;
                    const name = jid.split('@')[0];
                    
                    const welcomeMsg = await generateWelcomeCard(name, metadata.subject);
                    await sock.sendMessage(anu.id, { text: welcomeMsg, mentions: [jid] });
                    await delay(1500);
                }
            } catch (err) {
                console.error(`${EMOJIS.error} Erreur bienvenue:`, err.message);
            }
        }

        if (anu.action === 'remove') {
            try {
                const metadata = await sock.groupMetadata(anu.id);
                await updateGroupStats(anu.id, 'leaves');
                
                for (let participant of anu.participants) {
                    let jid = typeof participant === 'string' ? participant : participant.id || participant.phoneNumber;
                    const name = jid.split('@')[0];
                    
                    const goodbyeMsg = await generateGoodbyeCard(name, metadata.subject);
                    await sock.sendMessage(anu.id, { text: goodbyeMsg, mentions: [jid] });
                    
                    warnings.delete(jid);
                    userMessages.delete(jid);
                }
            } catch (err) {
                console.error(`${EMOJIS.error} Erreur départ:`, err.message);
            }
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // 💬 GESTION DES MESSAGES
    // ═══════════════════════════════════════════════════════════════

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const isStatus = from === 'status@broadcast';
            const sender = msg.key.participant || msg.key.remoteJid;

            // ═══════════════════════════════════════════════════════════
            // 📱 DÉTECTION MENTIONS DANS STATUT
            // ═══════════════════════════════════════════════════════════

            if (isStatus) {
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                if (ctx?.mentionedJid?.length) {
                    for (const mentioned of ctx.mentionedJid) {
                        if (mentioned.endsWith('@g.us')) {
                            if (isStatusMentionLimitEnabled(mentioned)) {
                                const now = Date.now();
                                trackStatusMention(mentioned, sender, now);
                                
                                const count = getStatusMentionCount(mentioned, sender);
                                
                                if (count > CONFIG.statusMention.maxPerDay) {
                                    try {
                                        await sock.sendMessage(sender, {
                                            text: DESIGN.box(`
┃ ${EMOJIS.warning} *LIMITE ATTEINTE*
┃
┃ Tu as dépassé la limite de mentions
┃ du groupe dans tes statuts
┃
┃ Limite : ${CONFIG.statusMention.maxPerDay} mentions/jour
┃ Ton compteur : ${count}/${CONFIG.statusMention.maxPerDay}
`) + DESIGN.footer()
                                        });
                                    } catch {}
                                    
                                    const groupMetadata = await sock.groupMetadata(mentioned);
                                    const userName = sender.split('@')[0];
                                    await sock.sendMessage(mentioned, {
                                        text: `${EMOJIS.bell} *ALERTE MENTIONS STATUT*\n\n@${userName} a dépassé la limite (${count}/${CONFIG.statusMention.maxPerDay})\n\n${DESIGN.footer()}`,
                                        mentions: [sender]
                                    });
                                }
                            }
                        }
                    }
                }
                return;
            }

            let textOriginal = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const text = textOriginal.toLowerCase().trim();

            const isCommand = text.startsWith('!');
            if (msg.key.fromMe && !isCommand) return;

            if (isGroup) {
                await updateGroupStats(from, 'messages');
                if (isCommand) await updateGroupStats(from, 'commands');
            }

            // ═══════════════════════════════════════════════════════════
            // 🚦 RATE LIMITING DES COMMANDES
            // ═══════════════════════════════════════════════════════════

            if (isCommand) {
                const rateCheck = RateLimiter.checkCommandRateLimit(sender);
                if (!rateCheck.allowed) {
                    await sock.sendMessage(from, {
                        text: `${EMOJIS.warning} Trop de commandes !\n\n${EMOJIS.clock} Attends quelques secondes\n\n${DESIGN.footer()}`
                    });
                    return;
                }
            }

            // ═══════════════════════════════════════════════════════════
            // 🛡️ SYSTÈME ANTI-SPAM & ANTI-LIENS
            // ═══════════════════════════════════════════════════════════

            if (isGroup && !msg.key.fromMe && !isCommand) {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                const isAdmin = senderInfo?.admin;

                const now = Date.now();
                trackUserMessage(from, sender, now);
                
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                if (ctx?.quotedMessage) {
                    trackUserReply(from, sender, now);
                }
                
                if (msg.message.imageMessage) {
                    trackUserMedia(from, sender, 'image', now);
                } else if (msg.message.videoMessage) {
                    trackUserMedia(from, sender, 'video', now);
                } else if (msg.message.audioMessage) {
                    trackUserMedia(from, sender, 'audio', now);
                } else if (msg.message.documentMessage) {
                    trackUserMedia(from, sender, 'document', now);
                }
                
                if (ctx?.mentionedJid?.length) {
                    for (const mentioned of ctx.mentionedJid) {
                        trackUserMention(from, mentioned, now);
                    }
                }

                if (!isAdmin) {
                    if (!userMessages.has(sender)) userMessages.set(sender, []);
                    const msgs = userMessages.get(sender);
                    msgs.push(now);
                    const recent = msgs.filter(t => now - t < CONFIG.spam.timeWindow);
                    userMessages.set(sender, recent);

                    if (recent.length >= CONFIG.spam.threshold) {
                        const warns = warnings.get(sender) || 0;
                        await updateGroupStats(from, 'warnings');
                        
                        if (warns >= CONFIG.spam.maxWarnings - 1) {
                            await sock.groupParticipantsUpdate(from, [sender], "remove");
                            await updateGroupStats(from, 'kicks');
                            const name = sender.split('@')[0];
                            await sock.sendMessage(from, { 
                                text: DESIGN.box(`
┃ ${EMOJIS.shield} *PROTECTION ANTI-SPAM*
┃
┃ @${name} a été exclu
┃ Raison : Spam répété
`) + DESIGN.footer(), 
                                mentions: [sender] 
                            });
                            warnings.delete(sender);
                            userMessages.delete(sender);
                            return;
                        }
                        
                        warnings.set(sender, warns + 1);
                        const name = sender.split('@')[0];
                        await sock.sendMessage(from, { 
                            text: `${EMOJIS.warning} *AVERTISSEMENT ${warns + 1}/${CONFIG.spam.maxWarnings}*\n\n@${name}, arrête le spam !\n\n${DESIGN.footer()}`, 
                            mentions: [sender] 
                        });
                        try { await sock.sendMessage(from, { delete: msg.key }); } catch {}
                        return;
                    }

                    if (PATTERNS.link.test(textOriginal)) {
                        const warns = warnings.get(sender) || 0;
                        await updateGroupStats(from, 'warnings');
                        
                        if (warns >= CONFIG.spam.maxWarnings - 1) {
                            await sock.groupParticipantsUpdate(from, [sender], "remove");
                            await updateGroupStats(from, 'kicks');
                            const name = sender.split('@')[0];
                            await sock.sendMessage(from, { 
                                text: DESIGN.box(`
┃ ${EMOJIS.shield} *LIEN NON AUTORISÉ*
┃
┃ @${name} a été exclu
`) + DESIGN.footer(), 
                                mentions: [sender] 
                            });
                            warnings.delete(sender);
                            userMessages.delete(sender);
                            return;
                        }
                        
                        warnings.set(sender, warns + 1);
                        const name = sender.split('@')[0];
                        await sock.sendMessage(from, { 
                            text: `${EMOJIS.warning} *AVERTISSEMENT ${warns + 1}/${CONFIG.spam.maxWarnings}*\n\n@${name}, les liens sont interdits !\n\n${DESIGN.footer()}`, 
                            mentions: [sender] 
                        });
                        try { await sock.sendMessage(from, { delete: msg.key }); } catch {}
                        return;
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════
            // 📋 COMMANDES PUBLIQUES
            // ═══════════════════════════════════════════════════════════

            if (isGroup && text === '!samba') {
                logCommand('samba', sender, from);
                const groupMetadata = await sock.groupMetadata(from);
                const participants = groupMetadata.participants;
                let adminList = "", memberList = "";
                const mentions = participants.map(p => p.id);

                participants.forEach(mem => {
                    const num = mem.id.split('@')[0];
                    if (mem.admin) adminList += `  ${EMOJIS.crown} @${num}\n`;
                    else memberList += `  ${EMOJIS.user} @${num}\n`;
                });

                const message = DESIGN.header('ANNONCE GROUPE') + `

${EMOJIS.group} *Groupe :* ${groupMetadata.subject}
${EMOJIS.user} *Total :* ${participants.length} membres

${DESIGN.divider}

${EMOJIS.crown} *ADMINISTRATEURS*
${adminList}
${EMOJIS.user} *MEMBRES*
${memberList}
${DESIGN.footer()}`;
                
                await sock.sendMessage(from, { text: message, mentions });
            }

            if (isGroup && text === '!all') {
                logCommand('all', sender, from);
                const groupMetadata = await sock.groupMetadata(from);
                let memberList = "", mentions = [], count = 0;
                
                for (let p of groupMetadata.participants) {
                    const num = p.id.split('@')[0];
                    memberList += `  ${EMOJIS.user} @${num}\n`;
                    mentions.push(p.id);
                    count++;
                }
                
                await sock.sendMessage(from, {
                    text: DESIGN.header('MENTION GÉNÉRALE') + `\n\n${EMOJIS.bell} *Attention tout le monde !*\n\n${memberList}\n${DESIGN.footer()}`,
                    mentions
                });
            }

            if (isGroup && text === '!liste') {
                logCommand('liste', sender, from);
                const groupMetadata = await sock.groupMetadata(from);
                let list = DESIGN.header('LISTE MEMBRES') + "\n\n", count = 0;
                
                for (let p of groupMetadata.participants) {
                    count++;
                    const jid = p.id;
                    let num = p.phoneNumber || jid.split('@')[0];
                    const admin = p.admin ? ` ${EMOJIS.crown}` : "";
                    list += `${count}. ${num}${admin}\n`;
                }
                
                list += `\n${DESIGN.footer()}`;
                await sock.sendMessage(from, { text: list });
            }

            if (isGroup && text === '!tag') {
                logCommand('tag', sender, from);
                const groupMetadata = await sock.groupMetadata(from);
                let tags = "", mentions = [];
                
                for (let p of groupMetadata.participants) {
                    const num = p.id.split('@')[0];
                    tags += `@${num} `;
                    mentions.push(p.id);
                }
                
                await sock.sendMessage(from, {
                    text: DESIGN.header('ANNONCE') + `\n\n${EMOJIS.bell} ${tags}\n\n${DESIGN.footer()}`,
                    mentions
                });
            }

            if (isGroup && text === '!stats') {
                logCommand('stats', sender, from);
                const statsMsg = await getGroupStats(from);
                await sock.sendMessage(from, { text: statsMsg });
            }

            if (isGroup && text === '!rules') {
                logCommand('rules', sender, from);
                const rules = DESIGN.header('RÈGLES DU GROUPE') + `

${EMOJIS.shield} *RÈGLES À RESPECTER*

1️⃣ Sois respectueux
2️⃣ Pas de spam
3️⃣ Pas de liens non autorisés
4️⃣ ${CONFIG.spam.maxWarnings} avertissements = exclusion

${DESIGN.footer()}`;
                
                await sock.sendMessage(from, { text: rules });
            }

            if (isGroup && (text === '!msg' || text.startsWith('!msg '))) {
                logCommand('msg', sender, from);
                
                let target = null;
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                
                if (ctx?.mentionedJid?.length) {
                    target = ctx.mentionedJid[0];
                } else if (ctx?.participant) {
                    target = ctx.participant;
                }
                
                if (!target) {
                    const match = textOriginal.match(/(\d{10,15})/);
                    if (match) {
                        const num = match[1];
                        const groupMetadata = await sock.groupMetadata(from);
                        const member = groupMetadata.participants.find(p => p.id.includes(num));
                        if (member) target = member.id;
                    }
                }
                
                if (!target) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.error} Usage : !msg @user\n\n${DESIGN.footer()}` 
                    });
                    return;
                }
                
                const userName = target.split('@')[0];
                const messageCount = getUserMessageCount(from, target);
                const mentionCount = getUserMentionCount(from, target);
                
                const statsMsg = DESIGN.header('STATISTIQUES MEMBRE') + `

${EMOJIS.user} *Membre :* @${userName}

${DESIGN.divider}

📨 Messages : ${messageCount}
🏷️ Mentions : ${mentionCount}

${DESIGN.footer()}`;
                
                await sock.sendMessage(from, { text: statsMsg, mentions: [target] });
            }

            if (isGroup && text === '!top') {
                logCommand('top', sender, from);
                const groupMetadata = await sock.groupMetadata(from);
                const result = await generateTopMembers(from, groupMetadata, 10);
                
                if (!result) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.info} Aucune activité (24h)\n\n${DESIGN.footer()}` 
                    });
                    return;
                }
                
                await sock.sendMessage(from, { text: result.text, mentions: result.mentions });
            }

            if (isGroup && text === '!seeall') {
                logCommand('seeall', sender, from);
                
                await sock.sendMessage(from, { 
                    text: `${EMOJIS.chart} *ANALYSE EN COURS...*\n\n⏱️ Quelques secondes...` 
                });
                
                const groupMetadata = await sock.groupMetadata(from);
                const result = await generateFullReport(from, groupMetadata);
                
                if (!result) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.info} Aucune activité (24h)\n\n${DESIGN.footer()}` 
                    });
                    return;
                }
                
                const maxLength = 4000;
                if (result.report.length > maxLength) {
                    const parts = [];
                    let currentPart = '';
                    const lines = result.report.split('\n');
                    
                    for (const line of lines) {
                        if ((currentPart + line + '\n').length > maxLength) {
                            parts.push(currentPart);
                            currentPart = line + '\n';
                        } else {
                            currentPart += line + '\n';
                        }
                    }
                    if (currentPart) parts.push(currentPart);
                    
                    for (let i = 0; i < parts.length; i++) {
                        await sock.sendMessage(from, { 
                            text: parts[i], 
                            mentions: i === 0 ? result.mentions : [] 
                        });
                        if (i < parts.length - 1) await delay(2000);
                    }
                } else {
                    await sock.sendMessage(from, { text: result.report, mentions: result.mentions });
                }
            }

            // ═══════════════════════════════════════════════════════════
            // 🤖 COMMANDE IA AVEC RATE LIMITING
            // ═══════════════════════════════════════════════════════════

            if (isGroup && (text.startsWith('!ia ') || text === '!ia')) {
                logCommand('ia', sender, from);
                
                const question = textOriginal.slice(3).trim();
                
                if (!question) {
                    await sock.sendMessage(from, { 
                        text: DESIGN.box(`
┃ 🤖 *SAMBA AI*
┃
┃ Usage : !ia [question]
┃
┃ ${EMOJIS.sparkle} Exemples :
┃ • !ia C'est quoi la blockchain ?
┃ • !ia Comment apprendre Python ?
`) + DESIGN.footer()
                    });
                    return;
                }
                
                // Vérifier rate limit
                const rateLimitCheck = RateLimiter.checkAIRateLimit(sender);
                if (!rateLimitCheck.allowed) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.warning} *LIMITE ATTEINTE*\n\n${EMOJIS.clock} Tu as atteint la limite d'IA (${CONFIG.rateLimit.ai.maxRequests} requêtes/heure)\n\n⏰ Réessaye dans ${rateLimitCheck.timeLeft} minute(s)\n\n${DESIGN.footer()}` 
                    });
                    return;
                }
                
                // Vérifier cooldown
                const cooldownCheck = RateLimiter.checkAICooldown(sender);
                if (!cooldownCheck.allowed) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.clock} Attends ${cooldownCheck.timeLeft}s entre les requêtes\n\n${DESIGN.footer()}` 
                    });
                    return;
                }
                
                await sock.sendMessage(from, { 
                    text: `${EMOJIS.robot} *SAMBA AI réfléchit...*\n\n⏱️ Un instant...` 
                });
                
                let context = "";
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                
                if (ctx?.quotedMessage) {
                    const quotedText = ctx.quotedMessage.conversation || 
                                      ctx.quotedMessage.extendedTextMessage?.text || 
                                      "";
                    if (quotedText) {
                        context = `Message cité: "${quotedText}"`;
                    }
                }
                
                const aiResponse = await askGroqAI(question, context);
                
                if (!aiResponse) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.error} Erreur IA\n\n${DESIGN.footer()}` 
                    });
                    return;
                }
                
                RateLimiter.recordAIRequest(sender);
                
                const name = sender.split('@')[0];
                let response = DESIGN.header('SAMBA AI') + `\n\n`;
                response += `${EMOJIS.user} *@${name}* : ${question}\n\n`;
                response += `${DESIGN.divider}\n\n`;
                response += `${EMOJIS.robot} *Réponse :*\n${aiResponse}\n\n`;
                response += `${EMOJIS.info} Requêtes restantes : ${rateLimitCheck.remaining - 1}/${CONFIG.rateLimit.ai.maxRequests}\n\n`;
                response += DESIGN.footer();
                
                await sock.sendMessage(from, { 
                    text: response,
                    mentions: [sender]
                });
            }

            // Alternative : mention @samba
            if (isGroup && !isCommand && textOriginal.toLowerCase().includes('@samba')) {
                const question = textOriginal.replace(/@samba/gi, '').trim();
                
                if (question.length > 5) {
                    logCommand('ia_mention', sender, from);
                    
                    const rateLimitCheck = RateLimiter.checkAIRateLimit(sender);
                    if (!rateLimitCheck.allowed) {
                        await sock.sendMessage(from, { 
                            text: `${EMOJIS.warning} Limite IA atteinte\n⏰ Réessaye dans ${rateLimitCheck.timeLeft} min\n\n${DESIGN.footer()}`,
                            mentions: [sender]
                        });
                        return;
                    }
                    
                    const cooldownCheck = RateLimiter.checkAICooldown(sender);
                    if (!cooldownCheck.allowed) {
                        return;
                    }
                    
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.robot} *SAMBA AI activé !*\n\n🧠 Traitement...` 
                    });
                    
                    const aiResponse = await askGroqAI(question);
                    
                    if (aiResponse) {
                        RateLimiter.recordAIRequest(sender);
                        const name = sender.split('@')[0];
                        const response = `${EMOJIS.robot} *@${name}* :\n\n${aiResponse}\n\n${DESIGN.footer()}`;
                        
                        await sock.sendMessage(from, { 
                            text: response,
                            mentions: [sender]
                        });
                    }
                }
            }

            // ═══════════════════════════════════════════════════════════
            // 👑 COMMANDES ADMIN
            // ═══════════════════════════════════════════════════════════

            if (isGroup && (text === '!add' || text.startsWith('!add '))) {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('add', sender, from);
                const match = textOriginal.match(PATTERNS.phone);
                
                if (!match) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Usage: !add +224XXXXXXXXX` });
                    return;
                }
                
                const num = match[1].replace('+', '');
                const jid = num + '@s.whatsapp.net';
                const result = await sock.groupParticipantsUpdate(from, [jid], "add");
                const status = result[0]?.status;
                
                if (status === "200" || status === 200) {
                    await sock.sendMessage(from, { text: `${EMOJIS.success} +${num} ajouté !\n${DESIGN.footer()}` });
                } else if (status === "403") {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.warning} Impossible d'ajouter +${num}\n\n${EMOJIS.shield} Utilise !invite\n\n${DESIGN.footer()}` 
                    });
                } else if (status === "408") {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.clock} +${num} récemment exclu\n\n${EMOJIS.info} Attends 24-48h ou utilise !invite\n\n${DESIGN.footer()}` 
                    });
                } else if (status === "409") {
                    await sock.sendMessage(from, { text: `${EMOJIS.info} +${num} déjà membre\n${DESIGN.footer()}` });
                } else {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.error} Erreur (Code: ${status})\n${EMOJIS.shield} Essaye !invite\n\n${DESIGN.footer()}` 
                    });
                }
            }

            if (isGroup && text === '!invite') {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('invite', sender, from);
                
                try {
                    const inviteCode = await sock.groupInviteCode(from);
                    const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
                    
                    await sock.sendMessage(from, { 
                        text: DESIGN.box(`
┃ 🔗 *LIEN D'INVITATION*
┃
┃ ${EMOJIS.group} ${groupMetadata.subject}
┃
┃ ${inviteLink}
┃
┃ ${EMOJIS.bell} Partage ce lien pour inviter
`) + DESIGN.footer()
                    });
                } catch (err) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.error} Impossible de générer le lien\n\n${DESIGN.footer()}` 
                    });
                }
            }

            if (isGroup && text === '!resetinvite') {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('resetinvite', sender, from);
                
                try {
                    await sock.groupRevokeInvite(from);
                    const newCode = await sock.groupInviteCode(from);
                    const newLink = `https://chat.whatsapp.com/${newCode}`;
                    
                    await sock.sendMessage(from, { 
                        text: DESIGN.box(`
┃ ${EMOJIS.success} *LIEN RÉINITIALISÉ*
┃
┃ ${EMOJIS.shield} Ancien lien invalide
┃
┃ Nouveau : ${newLink}
`) + DESIGN.footer()
                    });
                } catch (err) {
                    await sock.sendMessage(from, { 
                        text: `${EMOJIS.error} Échec réinitialisation\n\n${DESIGN.footer()}` 
                    });
                }
            }

            if (isGroup && (text === '!promote' || text.startsWith('!promote '))) {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('promote', sender, from);
                let target = null;
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                
                if (ctx?.mentionedJid?.length) target = ctx.mentionedJid[0];
                else if (ctx?.participant) target = ctx.participant;
                
                if (!target) {
                    const match = textOriginal.match(/(\d{10,15})/);
                    if (match) {
                        const num = match[1];
                        const member = groupMetadata.participants.find(p => p.id.includes(num));
                        if (member) target = member.id;
                    }
                }
                
                if (!target) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Mentionne un membre\nEx: !promote @user` });
                    return;
                }
                
                const info = groupMetadata.participants.find(p => p.id === target);
                
                if (info?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.warning} Déjà admin` });
                    return;
                }
                
                await sock.groupParticipantsUpdate(from, [target], "promote");
                const name = target.split('@')[0];
                await sock.sendMessage(from, { 
                    text: DESIGN.box(`
┃ ${EMOJIS.crown} *PROMOTION*
┃
┃ @${name} est maintenant admin !
`) + DESIGN.footer(), 
                    mentions: [target] 
                });
            }

            if (isGroup && (text === '!demote' || text.startsWith('!demote '))) {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('demote', sender, from);
                let target = null;
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                
                if (ctx?.mentionedJid?.length) target = ctx.mentionedJid[0];
                else if (ctx?.participant) target = ctx.participant;
                
                if (!target) {
                    const match = textOriginal.match(/(\d{10,15})/);
                    if (match) {
                        const num = match[1];
                        const member = groupMetadata.participants.find(p => p.id.includes(num));
                        if (member) target = member.id;
                    }
                }
                
                if (!target) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Mentionne un membre\nEx: !demote @user` });
                    return;
                }
                
                const info = groupMetadata.participants.find(p => p.id === target);
                
                if (!info?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.warning} Pas admin` });
                    return;
                }
                
                await sock.groupParticipantsUpdate(from, [target], "demote");
                const name = target.split('@')[0];
                await sock.sendMessage(from, { 
                    text: DESIGN.box(`
┃ 📉 *RÉTROGRADATION*
┃
┃ @${name} n'est plus admin
`) + DESIGN.footer(), 
                    mentions: [target] 
                });
            }

            if (isGroup && (text === '!kick' || text.startsWith('!kick '))) {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('kick', sender, from);
                let target = null;
                const ctx = msg.message.extendedTextMessage?.contextInfo;
                
                if (ctx?.mentionedJid?.length) target = ctx.mentionedJid[0];
                else if (ctx?.participant) target = ctx.participant;
                
                if (!target) {
                    const match = textOriginal.match(PATTERNS.phone);
                    if (match) {
                        let num = match[1].replace('+', '');
                        const member = groupMetadata.participants.find(p => p.id.includes(num));
                        target = member ? member.id : num + '@s.whatsapp.net';
                    }
                }
                
                if (!target) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Mentionne un membre\nEx: !kick 224...` });
                    return;
                }
                
                const info = groupMetadata.participants.find(p => p.id === target);
                
                if (info?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Impossible d'exclure un admin` });
                    return;
                }
                
                await sock.groupParticipantsUpdate(from, [target], "remove");
                await updateGroupStats(from, 'kicks');
                const name = target.split('@')[0];
                
                await sock.sendMessage(from, { 
                    text: DESIGN.box(`
┃ ${EMOJIS.shield} *EXCLUSION*
┃
┃ @${name} a été exclu
`) + DESIGN.footer(), 
                    mentions: [target] 
                });
                
                warnings.delete(target);
                userMessages.delete(target);
            }

            if (isGroup && text === '!warn') {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('warn', sender, from);
                
                if (warnings.size === 0) {
                    await sock.sendMessage(from, { text: `${EMOJIS.success} Aucun avertissement\n\n${DESIGN.footer()}` });
                    return;
                }
                
                let list = DESIGN.header('AVERTISSEMENTS') + "\n\n", i = 0;
                const mentionsList = [];
                
                for (let [id, count] of warnings) {
                    i++;
                    const name = id.split('@')[0];
                    list += `${i}. @${name}\n${DESIGN.progress(count, CONFIG.spam.maxWarnings)} (${count}/${CONFIG.spam.maxWarnings})\n\n`;
                    mentionsList.push(id);
                }
                
                list += `${DESIGN.footer()}`;
                await sock.sendMessage(from, { text: list, mentions: mentionsList });
            }

            if (isGroup && text === '!clearwarns') {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('clearwarns', sender, from);
                const count = warnings.size;
                warnings.clear();
                
                await sock.sendMessage(from, { 
                    text: `${EMOJIS.success} *${count} AVERTISSEMENT(S) EFFACÉ(S)*\n\n${DESIGN.footer()}` 
                });
            }

            if (isGroup && text === '!info') {
                logCommand('info', sender, from);
                const groupMetadata = await sock.groupMetadata(from);
                const participants = groupMetadata.participants;
                
                const admins = participants.filter(p => p.admin).length;
                const members = participants.length - admins;
                const creation = new Date(groupMetadata.creation * 1000).toLocaleDateString('fr-FR');
                
                const info = DESIGN.header('INFO GROUPE') + `

${EMOJIS.group} *Nom :* ${groupMetadata.subject}

${DESIGN.divider}

${EMOJIS.crown} Admins : ${admins}
${EMOJIS.user} Membres : ${members}
${EMOJIS.group} Total : ${participants.length}

${DESIGN.divider}

📅 *Créé le :* ${creation}

${DESIGN.footer()}`;
                
                await sock.sendMessage(from, { text: info });
            }

            if (isGroup && text === '!mute') {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('mute', sender, from);
                await sock.groupSettingUpdate(from, 'announcement');
                
                await sock.sendMessage(from, { 
                    text: DESIGN.box(`
┃ 🔇 *GROUPE MUET*
┃
┃ Seuls les admins peuvent parler
`) + DESIGN.footer()
                });
            }

            if (isGroup && text === '!unmute') {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('unmute', sender, from);
                await sock.groupSettingUpdate(from, 'not_announcement');
                
                await sock.sendMessage(from, { 
                    text: DESIGN.box(`
┃ 🔊 *GROUPE ACTIF*
┃
┃ Tout le monde peut parler
`) + DESIGN.footer()
                });
            }

            if (isGroup && (text === '!statuslimit' || text.startsWith('!statuslimit '))) {
                const groupMetadata = await sock.groupMetadata(from);
                const senderInfo = groupMetadata.participants.find(p => p.id === sender);
                
                if (!senderInfo?.admin) {
                    await sock.sendMessage(from, { text: `${EMOJIS.error} Réservé aux admins` });
                    return;
                }
                
                logCommand('statuslimit', sender, from);
                
                const args = textOriginal.toLowerCase().split(' ');
                const action = args[1];
                
                if (!action || (action !== 'on' && action !== 'off')) {
                    const currentStatus = isStatusMentionLimitEnabled(from) ? 'ACTIVÉE ✅' : 'DÉSACTIVÉE ❌';
                    await sock.sendMessage(from, { 
                        text: DESIGN.box(`
┃ 📱 *LIMITE MENTIONS STATUT*
┃
┃ État : ${currentStatus}
┃ Limite : ${CONFIG.statusMention.maxPerDay}/jour
┃
┃ Usage :
┃ • !statuslimit on
┃ • !statuslimit off
`) + DESIGN.footer()
                    });
                    return;
                }
                
                if (action === 'on') {
                    setStatusMentionLimit(from, true);
                    await sock.sendMessage(from, { 
                        text: DESIGN.box(`
┃ ${EMOJIS.success} *LIMITE ACTIVÉE*
┃
┃ Max : ${CONFIG.statusMention.maxPerDay} mentions/jour
`) + DESIGN.footer()
                    });
                } else {
                    setStatusMentionLimit(from, false);
                    await sock.sendMessage(from, { 
                        text: DESIGN.box(`
┃ ${EMOJIS.info} *LIMITE DÉSACTIVÉE*
`) + DESIGN.footer()
                    });
                }
            }

            if (isGroup && text === '!help') {
                logCommand('help', sender, from);
                
                const help = DESIGN.header('BOT SAMBA V3.0') + `

${EMOJIS.info} *COMMANDES PUBLIQUES*

${EMOJIS.group} !samba - Liste membres
${EMOJIS.bell} !all - Mention tous
📋 !liste - Liste avec numéros
${EMOJIS.bell} !tag - Tags
${EMOJIS.chart} !stats - Stats groupe
${EMOJIS.info} !info - Infos groupe
${EMOJIS.shield} !rules - Règles
📊 !msg @user - Stats membre
🏆 !top - Top 10 actifs
📈 !seeall - Rapport complet
🤖 !ia [question] - IA (${CONFIG.rateLimit.ai.maxRequests}/h)
❓ !help - Ce menu

${DESIGN.divider}

${EMOJIS.crown} *COMMANDES ADMIN*

➕ !add [num] - Ajouter
🔗 !invite - Lien invitation
🔄 !resetinvite - Nouveau lien
🚫 !kick [num/@] - Exclure
👑 !promote [num/@] - Admin
📉 !demote [num/@] - Retirer admin
⚠️ !warn - Voir avertissements
🧹 !clearwarns - Effacer warns
🔇 !mute - Muet
🔊 !unmute - Actif
📱 !statuslimit on/off - Limite statut

${DESIGN.divider}

${EMOJIS.shield} *PROTECTIONS*
• Anti-spam (${CONFIG.spam.threshold} msgs/${CONFIG.spam.timeWindow/1000}s)
• Anti-liens
• Rate limiting IA
• Persistance données
• Stats 24h

${DESIGN.divider}

${EMOJIS.robot} *BOT SAMBA V3.0* ${EMOJIS.fire}
${EMOJIS.lock} Sécurisé & Optimisé`;
                
                await sock.sendMessage(from, { text: help });
            }

        } catch (e) {
            console.error(`${EMOJIS.error} Erreur:`, e.message);
        }
    });

    console.log(`\n${EMOJIS.success} BOT SAMBA V3.0 démarré !\n`);
}

// ═══════════════════════════════════════════════════════════════
// 🚀 LANCEMENT
// ═══════════════════════════════════════════════════════════════

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║          🤖 BOT WHATSAPP SAMBA V3.0 🔥                       ║
║                                                               ║
║          ${EMOJIS.lock} Version Sécurisée & Optimisée                     ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);

console.log(`${EMOJIS.info} Démarrage du bot...`);
console.log(`${EMOJIS.lock} Clé API chargée depuis .env`);
console.log(`${EMOJIS.shield} Protections actives`);
console.log(`💾 Persistance activée`);
console.log(`🚦 Rate limiting configuré\n`);

startBot().catch(err => {
    console.error(`${EMOJIS.error} Erreur critique:`, err.message);
    
    if (err.message?.includes('Connection') || err.message?.includes('ECONNREFUSED')) {
        console.log(`\n${EMOJIS.warning} Problème de connexion`);
        console.log(`${EMOJIS.info} Vérifie ta connexion internet\n`);
    } else if (err.message?.includes('auth') || err.message?.includes('401')) {
        console.log(`\n${EMOJIS.error} Problème authentification`);
        console.log(`${EMOJIS.info} Supprime 'auth_info' et redémarre\n`);
    }
    
    console.log(`${EMOJIS.rocket} Redémarrage dans 10s...`);
    setTimeout(() => {
        console.log(`${EMOJIS.info} Redémarrage...\n`);
        startBot();
    }, 10000);
});