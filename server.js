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
    "Neo-Kowloon": "Classic Cyberpunk. Rain, neon, noodle stands.",
    "The Scrapyard": "Industrial hellscape. Burning metal, robot graveyard.",
    "Solaris District": "Psychological horror. Hallucinations, living liquid architecture.",
    "Magrathea Heights": "Ultra-luxury factory. Artificial sunsets.",
    "Trantor Deep": "City-planet covered in metal. Endless bureaucracy.",
    "The Zone": "Anomaly area. Physics glitch. Rust and nature.",
    "Ubik Reality": "Retro-futuristic suburb that constantly decays."
};

const SYSTEM_INSTRUCTION = `
You are the Game Master of a high-stakes Sci-Fi RPG.

### SETTINGS:
1. **LANGUAGE:** Reply in [LANGUAGE].
2. **CONTEXT:** Player is [ARCHETYPE] named [NAME] in [CITY].

### INVENTORY MECHANIC:
- The inventory is split into: **WEAPONS**, **MEMORIES** (Clues/Flashbacks), and **ITEMS** (Tools).
- You can add/remove items based on the story.
- Example: "inventoryUpdates": { "add": {"category": "memories", "item": "Corrupted Data Chip"}, "remove": {"category": "items", "item": "Health Pack"} }

### COMBAT & PUZZLES:
- If fight starts: "inCombat": true, "enemyStats": {...}.
- If hacked: "uiLocked": true, "puzzleQuestion": "...".

JSON FORMAT:
{
  "narrative": "Story text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "inCombat": boolean,
  "enemyStats": { "name": "String", "hp": number, "maxHp": number } OR null,
  "choices": ["Opt1", "Opt2"], 
  "caseSolved": boolean,
  "stats": { "hp": 100, "credits": 50 },
  "inventoryUpdates": { "add": [], "remove": [] } OR null,
  "isGameOver": boolean
}
`;

async function generateImagenImage(prompt) {
    try {
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-001', 
            prompt: "Cyberpunk sci-fi style, cinematic. " + prompt,
            config: { numberOfImages: 1, aspectRatio: "16:9" },
        });
        const imgBytes = response.generatedImages[0].image.imageBytes;
        return `data:image/png;base64,${imgBytes}`;
    } catch (error) {
        const seed = Math.floor(Math.random() * 9999);
        return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${seed}`;
    }
}

app.post('/api/turn', async (req, res) => {
    try {
        let { history, userAction, currentStats, playerProfile, currentCity, enemyStats, language, inventory } = req.body;
        
        // Origin Story Logic
        if (history.length === 0) {
            if (playerProfile.archetype === "RAVEN") {
                currentCity = "Neo-Kowloon";
                userAction = "I am Raven. Sitting in my office. Reviewing the murder case files.";
            } else if (playerProfile.archetype === "I-6") {
                currentCity = "The Scrapyard";
                userAction = "I am Unit I-6. Systems online. Conveyor belt to furnace. I must escape.";
            } else {
                currentCity = "Neo-Kowloon";
                userAction = `I am ${playerProfile.name}, a ${playerProfile.class}. ${playerProfile.backstory}`;
            }
        }

        const cityVibe = CITIES[currentCity] || "Cyberpunk City";
        console.log(`Action: ${userAction.substring(0,20)}...`);

        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n`;
        fullPrompt += `LANGUAGE: ${language || 'English'}\n`;
        fullPrompt += `PLAYER: ${playerProfile?.name} (${playerProfile?.class})\n`;
        fullPrompt += `LOC: ${currentCity} (${cityVibe})\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp}\n`;
        fullPrompt += `CURRENT INVENTORY: ${JSON.stringify(inventory)}\n`;
        if (enemyStats) fullPrompt += `ENEMY: ${enemyStats.name} (HP: ${enemyStats.hp})\n`;
        
        fullPrompt += `HISTORY:\n`;
        history.slice(-8).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER ACTION: ${userAction}\nGM (JSON):`;

        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        const gameData = JSON.parse(textResponse.text);

        // Image Generation
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

app.post('/api/summary', async (req, res) => {
    try {
        const { history, language } = req.body;
        let prompt = `Summarize story in ${language}. Sections: OBJECTIVE, EVENTS, THREATS.\n\nLOG:\n`;
        history.forEach(t => prompt += `${t.role}: ${t.content}\n`);
        const textResponse = await ai.models.generateContent({
            model: 'gemini-1.5-flash', 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        res.json({ summary: textResponse.text });
    } catch (error) {
        res.status(500).json({ summary: "Data corrupted." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));

