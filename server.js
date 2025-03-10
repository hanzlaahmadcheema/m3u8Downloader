const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const { exec } = require("child_process");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8080;

// Serve static files
app.use(express.static("downloads"));

app.use(cors({
  origin: "*", // Allow all origins
  methods: ["GET", "POST"], // Only allow GET and POST
  allowedHeaders: ["Content-Type"]
}));
// Allow all origins

// Endpoint to download and convert M3U8
app.get("/download", async (req, res) => {
  const episodeUrl = req.query.Url;
  if (!episodeUrl) {
    return res.status(400).json({ error: "URL is required" });
  }

  const outputFilename = `episode-${Date.now()}.mp4`;
  const outputPath = path.join(__dirname, "downloads", outputFilename);

  const ffmpegProcess = ffmpeg(episodeUrl)
    .output(outputPath)
    .on("progress", (progress) => {
      console.log(`Download Progress: ${progress.percent}%`);
    })
    .on("end", () => {
      console.log("Download complete!");
      res.json({ success: true, downloadUrl: `/downloads/${outputFilename}` });
    })
    .on("error", (err) => {
      console.error("FFmpeg Error:", err.message);
      res.status(500).json({ error: "FFmpeg conversion failed" });
    });

  ffmpegProcess.run();
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
