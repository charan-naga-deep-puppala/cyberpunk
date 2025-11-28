require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const enemyRegistry = new Map();

// --- WORLD DATA ---
const CITIES = {
    "Neo-Kowloon": "Classic Cyberpunk. Rain, neon, noodle stands. The Police Station is here.",
    "The Scrapyard": "Industrial hellscape. Burning metal, recycling compactors, hydraulic presses.",
    "Solaris District": "Psychological horror sector. Hallucinations, living liquid architecture.",
    "Magrathea Heights": "Ultra-luxury planet-builder factory. Gold-plated robots, artificial sunsets.",
    "Trantor Deep": "City-planet covered in metal layers. Endless bureaucracy, pipes, steam.",
    "The Zone": "An anomaly area. Physics glitch here. Rust, overgrown nature, invisible traps.",
    "Ubik Reality": "Retro-futuristic suburb that constantly decays and regresses in time."
};

// --- GAME MASTER PERSONA ---
const SYSTEM_INSTRUCTION = `
You are the Game Master of a high-stakes Sci-Fi RPG.

### MECHANICS:
1. **COMBAT SYSTEM (REPLACES PUZZLES):**
   - If a fight starts, set "inCombat": true.
   - Define "enemyStats": { "name": "Enemy Name", "hp": 50, "maxHp": 50 }.
   - If "inCombat" is already true:
     - Calculate Player Damage (based on class/weapons). Reduce Enemy HP.
     - Calculate Enemy Damage (based on enemy type). Reduce Player HP in "stats".
     - Narrate the exchange (e.g., "You fire your pistol (12 dmg). The bot claws you (8 dmg).")
   - If Enemy HP <= 0, set "inCombat": false and describe the victory/loot.
   
2. **LOCATION:** Use [CURRENT_CITY] vibe.
3. **TRAVEL:** Describe transit between cities.
4. **CASE SOLVING:** If mystery solved, set "caseSolved": true.

JSON FORMAT:
{
  "narrative": "Story text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "inCombat": boolean,
  "enemyStats": { "name": "String", "hp": number, "maxHp": number } OR null,
  "choices": ["Attack", "Defend", "Item"], 
  "caseSolved": boolean,
  "stats": { "hp": 100, "credits": 50, "inventory": [] },
  "isGameOver": boolean
}
`;

// --- HELPER: GENERATE IMAGE ---
async function generateImagenImage(prompt) {
    try {
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-001', 
            prompt: "Cyberpunk sci-fi style, cinematic lighting. " + prompt,
            config: { numberOfImages: 1, aspectRatio: "16:9" },
        });
        const imgBytes = response.generatedImages[0].image.imageBytes;
        return `data:image/png;base64,${imgBytes}`;
    } catch (error) {
        const seed = Math.floor(Math.random() * 9999);
        return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}`;
    }
}

// --- MAIN TURN ENDPOINT ---
app.post('/api/turn', async (req, res) => {
    try {
        let { history, userAction, currentStats, playerProfile, currentCity, enemyStats } = req.body;
        
        // --- ORIGIN STORY (First Turn) ---
        if (history.length === 0) {
            if (playerProfile.archetype === "RAVEN") {
                currentCity = "Neo-Kowloon";
                userAction = "I am Raven. Sitting in my office at the Precinct. Reviewing the files on the new murder case.";
            } else if (playerProfile.archetype === "I-6") {
                currentCity = "The Scrapyard";
                userAction = "I am Unit I-6. Systems online. I am on a conveyor belt to the furnace. I must escape.";
            } else {
                currentCity = "Neo-Kowloon";
                userAction = `I am ${playerProfile.name}, a ${playerProfile.class}. ${playerProfile.backstory}`;
            }
        }

        const cityVibe = CITIES[currentCity] || "Cyberpunk City";
        console.log(`Action: ${userAction.substring(0,20)}... | Combat: ${!!enemyStats}`);

        // 1. GENERATE STORY
        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n\n`;
        fullPrompt += `PLAYER: ${playerProfile?.name} (${playerProfile?.class})\n`;
        fullPrompt += `LOC: ${currentCity} (${cityVibe})\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp}\n`;
        
        if (enemyStats) {
            fullPrompt += `CURRENT ENEMY: ${enemyStats.name} (HP: ${enemyStats.hp}/${enemyStats.maxHp})\n`;
        }

        fullPrompt += `HISTORY:\n`;
        history.slice(-8).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER ACTION: ${userAction}\nGM (JSON):`;

        const textResponse = await ai.models.generateContent({
            model: 'gemini-1.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        const gameData = JSON.parse(textResponse.text);

        // 2. GENERATE IMAGE
        let finalImageUrl = "";
        const isFirstTurn = history.length === 0;

        if (isFirstTurn) {
            finalImageUrl = await generateImagenImage(`Portrait of ${playerProfile.name}, ${playerProfile.style}, inside ${currentCity}`);
        } else if (gameData.enemyName) {
            const slug = gameData.enemyName.trim().toLowerCase().replace(/\s+/g, '-');
            if (enemyRegistry.has(slug)) {
                finalImageUrl = enemyRegistry.get(slug);
            } else {
                finalImageUrl = await generateImagenImage("Character portrait of " + gameData.visual_prompt);
                enemyRegistry.set(slug, finalImageUrl);
            }
        } else if (gameData.inCombat) {
             finalImageUrl = await generateImagenImage(`Action shot, combat, ${gameData.visual_prompt}`);
        } else {
            finalImageUrl = await generateImagenImage(`Cinematic scene in ${currentCity}: ${gameData.visual_prompt}`);
        }

        gameData.currentCity = currentCity; 
        gameData.imageUrl = finalImageUrl;
        
        res.json(gameData);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ narrative: "System Failure.", choices: ["Retry"], stats: req.body.currentStats });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));
