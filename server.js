require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const AWS = require("aws-sdk");

const app = express();
const PORT = process.env.PORT || 3002;

// Cloudflare R2 Configuration
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: "v4",
});

// Bucket Names
const BUCKET_PRIMARY = process.env.BUCKET_PRIMARY;
const BUCKET_USER = process.env.BUCKET_USER;

app.use(express.json());
app.use(cors({ origin: "*" })); // Allow all origins

let progressData = {}; // Store progress for each file

// Function to check if file exists in an R2 bucket
async function checkFileInBucket(bucket, fileName) {
  try {
    await s3
      .headObject({
        Bucket: bucket,
        Key: `${fileName}.mp4`,
      })
      .promise();
    return true; // File exists
  } catch (error) {
    return false; // File not found
  }
}

// Route to check if file exists in R2 storage
app.get("/check-file", async (req, res) => {
  const { fileName } = req.query;

  try {
    const existsPrimary = await checkFileInBucket(BUCKET_PRIMARY, fileName);
    const existsUser = await checkFileInBucket(BUCKET_USER, fileName);

    if (existsPrimary || existsUser) {
      console.log(`File ${fileName}.mp4 found in R2.`);
      return res.json({ exists: true });
    }

    res.json({ exists: false });
  } catch (error) {
    console.error("Error checking file in R2:", error);
    res.status(500).json({ success: false, error: "Error checking file." });
  }
});

// Route to download and convert M3U8 to MP4, then upload to R2
app.post("/download", async (req, res) => {
  const { episodeUrl, fileName } = req.body;
  const tempFilePath = path.join(__dirname, `${fileName}.mp4`);

  if (!episodeUrl || !fileName) {
    return res.status(400).json({ success: false, error: "Missing parameters" });
  }

  try {
    // Check if file exists in either bucket before downloading
    const existsPrimary = await checkFileInBucket(BUCKET_PRIMARY, fileName);
    const existsUser = await checkFileInBucket(BUCKET_USER, fileName);

    if (existsPrimary || existsUser) {
      console.log(`Skipping download, ${fileName}.mp4 already exists in R2.`);
      return res.json({ success: true, message: "File already exists" });
    }

    console.log(`Starting download: ${fileName}.mp4 from ${episodeUrl}`);

    // Spawn FFmpeg process
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      episodeUrl,
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      tempFilePath,
    ]);

    progressData[fileName] = { progress: 0, totalTime: null };

    ffmpeg.stderr.on("data", (data) => {
      const output = data.toString();
      console.log(`FFmpeg Log: ${output}`);

      if (!progressData[fileName].totalTime) {
        const durationMatch = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (durationMatch) {
          const [_, hours, minutes, seconds] = durationMatch;
          progressData[fileName].totalTime =
            parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
        }
      }

      const timeMatch = output.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && progressData[fileName].totalTime) {
        const [_, hours, minutes, seconds] = timeMatch;
        const currentTime =
          parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds);
        progressData[fileName].progress = Math.min(
          ((currentTime / progressData[fileName].totalTime) * 100).toFixed(2),
          100
        );
        console.log(`Download Progress: ${progressData[fileName].progress}%`);
      }
    });

    ffmpeg.on("close", async (code) => {
      if (code === 0) {
        progressData[fileName].progress = 100;
        console.log(`Download completed: ${fileName}.mp4`);

        // Upload to Cloudflare R2 (user-episodes bucket)
        const fileStream = fs.createReadStream(tempFilePath);
        await s3
          .upload({
            Bucket: BUCKET_USER,
            Key: `${fileName}.mp4`,
            Body: fileStream,
            ContentType: "video/mp4",
          })
          .promise();

        console.log(`Uploaded to R2: ${fileName}.mp4`);
        fs.unlinkSync(tempFilePath); // Remove temporary file
      } else {
        console.error(`FFmpeg error: Process exited with code ${code}`);
        delete progressData[fileName];
      }
    });

    res.json({ success: true, message: "Download started" });
  } catch (error) {
    console.error("FFmpeg process failed:", error);
    res.status(500).json({ success: false, error: "Failed to start FFmpeg process" });
  }
});

// Route to get real-time progress
app.get("/progress/:fileName", (req, res) => {
  const { fileName } = req.params;
  const progress = progressData[fileName]?.progress || 0;
  res.json({ progress });
});

// Route to serve MP4 files from Cloudflare R2
app.get("/download/:fileName", async (req, res) => {
  const { fileName } = req.params;

  try {
    const existsPrimary = await checkFileInBucket(BUCKET_PRIMARY, fileName);
    const existsUser = await checkFileInBucket(BUCKET_USER, fileName);

    if (!existsPrimary && !existsUser) {
      return res.status(404).json({ error: "File not found" });
    }

    // Generate a signed URL for direct download
    const url = s3.getSignedUrl("getObject", {
      Bucket: existsPrimary ? BUCKET_PRIMARY : BUCKET_USER,
      Key: `${fileName}.mp4`,
      Expires: 3600, // 1 hour expiry
    });

    console.log(`Serving download link: ${url}`);
    res.json({ success: true, url });
  } catch (error) {
    console.error("Error generating download link:", error);
    res.status(500).json({ success: false, error: "Failed to generate link" });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});