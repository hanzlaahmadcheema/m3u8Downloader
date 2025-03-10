const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files
app.use(express.static("downloads"));

// Endpoint to download and convert M3U8
app.get("/download", async (req, res) => {
  const episodeUrl = req.query.episodeUrl;
  if (!episodeUrl) {
    return res.status(400).json({ error: "Episode URL is required" });
  }

  const outputFilename = `episode-${Date.now()}.mp4`;
  const outputPath = path.join(__dirname, "downloads", outputFilename);

  try {
    exec(`ffmpeg -i "${episodeUrl}" -c copy -bsf:a aac_adtstoasc "${outputPath}"`, (error) => {
      if (error) {
        return res.status(500).json({ error: "FFmpeg conversion failed", details: error.message });
      }
      
      res.json({ success: true, downloadUrl: `/downloads/${outputFilename}` });
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to start FFmpeg process" });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
