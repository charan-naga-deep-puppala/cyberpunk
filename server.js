require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
1. **Never use a metaphor, simile, or figure of speech.**
2. **Never use a long word where a short one will do.**
3. **If it is possible to cut a word out, always cut it out.**
4. **Never use the passive where you can use the active.**
5. **Use everyday English.**
6. **NO SOUND EFFECTS.**
7. **FORMAT:** Write in clear paragraphs. No screenplay format.

### STRUCTURE:
- **INTRODUCTION:** Can be detailed for lore.
- **TURNS:** Direct action and reaction.
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

// --- NEW IMAGE GENERATION FUNCTION (Based on your snippet) ---
async function generateGeminiImage(prompt) {
    try {
        console.log(">> Generating Image with Gemini 2.5 Flash...");
        
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-image", // Hardcoded as requested
            contents: "Create a cyberpunk noir style illustration: " + prompt,
        });

        // Extract base64 image data from the response
        for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
                // Construct the data URL for the frontend
                return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
        }
        
        console.warn(">> No inlineData found in Gemini response.");
        return null;

    } catch (error) {
        console.error(">> Gemini Image Error:", error);
        return "https://placehold.co/600x400/000000/00ff41?text=VISUAL+FEED+ERROR";
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
        history.slice(-6).forEach(t => fullPrompt += `${t.role.toUpperCase()}: ${t.content}\n`);
        fullPrompt += `PLAYER ACTION: ${userAction}\nGM (JSON):`;

        // MODEL HARDCODED TO 2.5 FLASH
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: { responseMimeType: 'application/json' }
        });

        const gameData = JSON.parse(textResponse.text());

        // Image Generation Call
        let finalImageUrl = "";
        const isFirstTurn = history.length === 0;

        // Use the new Gemini Image function
        if (isFirstTurn) {
            finalImageUrl = await generateGeminiImage(`Portrait of ${playerProfile.name}, ${playerProfile.style}, inside ${currentCity}`);
        } else if (gameData.enemyName) {
            const slug = gameData.enemyName.trim().toLowerCase().replace(/\s+/g, '-');
            if (enemyRegistry.has(slug)) {
                finalImageUrl = enemyRegistry.get(slug);
            } else {
                finalImageUrl = await generateGeminiImage("Character portrait of " + gameData.visual_prompt);
                enemyRegistry.set(slug, finalImageUrl);
            }
        } else if (gameData.inCombat) {
             finalImageUrl = await generateGeminiImage(`Action shot, combat, ${gameData.visual_prompt}`);
        } else {
            finalImageUrl = await generateGeminiImage(`Cinematic scene in ${currentCity}: ${gameData.visual_prompt}`);
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
        
        // MODEL HARDCODED TO 2.5 FLASH
        const textResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        res.json({ summary: textResponse.text() });
    } catch (error) {
        res.status(500).json({ summary: "Data corrupted." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(port, () => console.log(`Server running on port ${port}`));
