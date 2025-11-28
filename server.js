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

const CITIES = {
    "Neo-Kowloon": "Rain. Neon. Noodle stands. Concrete.",
    "The Scrapyard": "Rust. Fire. Metal crushers.",
    "Solaris District": "Water. Glass. Strange lights.",
    "Magrathea Heights": "Gold. Fake sun. Clean air.",
    "Trantor Deep": "Metal walls. Pipes. Steam.",
    "The Zone": "Trees. Radiation. Silence.",
    "Ubik Reality": "Old houses. Fading colors. Decay."
};

const SYSTEM_INSTRUCTION = `
You are the Game Master of a Sci-Fi RPG.

### WRITING RULES (STRICT):
1. **Never use a metaphor, simile, or figure of speech.** 2. **Never use a long word where a short one will do.**
3. **If it is possible to cut a word out, always cut it out.**
4. **Never use the passive where you can use the active.**
5. **Use everyday English** (Scientific/Sci-Fi terms are allowed only when necessary).
6. **NO SOUND EFFECTS** (Do not write *click*, *bang*, etc).
7. **FORMAT:** Write in clear paragraphs. Do not use screenplay format.

### STRUCTURE:
- **INTRODUCTION:** Can be long. Establish the setting and the stakes clearly.
- **SUBSEQUENT TURNS:** Keep it direct. Action and reaction.
- **PERSPECTIVE:** Second person ("You see...", "You do...").

### MECHANICS:
1. **COMBAT:** Headshots or Core hits are fatal. Player death = "isGameOver": true.
2. **CHARACTERS:** If a NEW NPC appears, add to "newCharacters".
3. **LANGUAGE:** Respond ONLY in [LANGUAGE].

JSON FORMAT:
{
  "narrative": "Story text.",
  "visual_prompt": "Visual description.",
  "enemyName": "String or null",
  "inCombat": boolean,
  "enemyStats": { "name": "String", "hp": number, "maxHp": number } OR null,
  "newCharacters": [ { "name": "Name", "description": "Visual details..." } ] OR null,
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
            prompt: "Cyberpunk sci-fi style, cinematic, detailed. " + prompt,
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
                userAction = "I am Raven. I sit in my office at the Precinct. I review the files on the new murder case.";
            } else if (playerProfile.archetype === "I-6") {
                currentCity = "The Scrapyard";
                userAction = "I am Unit I-6. My systems reboot. I lie on a conveyor belt moving toward a furnace. I must escape.";
            } else {
                currentCity = "Neo-Kowloon";
                userAction = `I am ${playerProfile.name}, a ${playerProfile.class}. ${playerProfile.backstory}`;
            }
        }

        const cityVibe = CITIES[currentCity] || "Cyberpunk City";
        
        let fullPrompt = `SYSTEM: ${SYSTEM_INSTRUCTION}\n`;
        fullPrompt += `LANGUAGE: ${language || 'English'}\n`;
        fullPrompt += `PLAYER: ${playerProfile?.name} (${playerProfile?.class})\n`;
        fullPrompt += `LOC: ${currentCity} (${cityVibe})\n`;
        fullPrompt += `STATUS: HP=${currentStats.hp}\n`;
        fullPrompt += `INVENTORY: ${JSON.stringify(inventory)}\n`;
        if (enemyStats) fullPrompt += `ENEMY: ${enemyStats.name} (HP: ${enemyStats.hp})\n`;
        
        fullPrompt += `HISTORY:\n`;
        // Send less history to encourage immediate focus, but enough for context
        history.slice(-6).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
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
        let prompt = `Role: Database. Summarize in ${language}. Sections: OBJECTIVE, EVENTS, THREATS. Use simple words.\n\nLOG:\n`;
        history.forEach(t => prompt += `${t.role}: ${t.content}\n`);
        
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        res.json({ summary: textResponse.text });
    } catch (error) {
        res.status(500).json({ summary: "Data corrupted." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));
