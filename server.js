require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const oci = require("oci-sdk"); // Oracle SDK

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(cors({ origin: "*" })); // Allow all origins

let progressData = {}; // Store progress for each file

// Oracle Cloud Configuration
const provider = new oci.common.ConfigFileAuthenticationDetailsProvider("~/.oci/config");
const objectStorageClient = new oci.objectstorage.ObjectStorageClient({
  authenticationDetailsProvider: provider,
});

// Bucket Names
const namespace = process.env.OCI_NAMESPACE;
const BUCKET_PRIMARY = process.env.BUCKET_PRIMARY; // Main bucket
const BUCKET_USER = process.env.BUCKET_USER; // User-upload bucket

// Function to check if a file exists in Oracle Storage
async function checkFileInBucket(bucket, fileName) {
  try {
    await objectStorageClient.headObject({
      namespaceName: namespace,
      bucketName: bucket,
      objectName: `${fileName}.mp4`,
    });
    return true; // File exists
  } catch (error) {
    return false; // File not found
  }
}

// Route to check if a file exists
app.get("/check-file", async (req, res) => {
  const { fileName } = req.query;

  try {
    const existsPrimary = await checkFileInBucket(BUCKET_PRIMARY, fileName);
    const existsUser = await checkFileInBucket(BUCKET_USER, fileName);

    if (existsPrimary || existsUser) {
      console.log(`File ${fileName}.mp4 found in Oracle Storage.`);
      return res.json({ exists: true });
    }

    res.json({ exists: false });
  } catch (error) {
    console.error("Error checking file:", error);
    res.status(500).json({ success: false, error: "Error checking file." });
  }
});

// Route to download and convert M3U8 to MP4, then upload to Oracle Storage
app.post("/download", async (req, res) => {
  const { episodeUrl, fileName } = req.body;
  const tempFilePath = path.join(__dirname, `${fileName}.mp4`);

  if (!episodeUrl || !fileName) {
    return res.status(400).json({ success: false, error: "Missing parameters" });
  }

  try {
    // Check if the file already exists
    const existsPrimary = await checkFileInBucket(BUCKET_PRIMARY, fileName);
    const existsUser = await checkFileInBucket(BUCKET_USER, fileName);

    if (existsPrimary || existsUser) {
      console.log(`Skipping download, ${fileName}.mp4 already exists.`);
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

        // Upload to Oracle Cloud
        const fileStream = fs.createReadStream(tempFilePath);
        const uploadDetails = {
          namespaceName: namespace,
          bucketName: BUCKET_USER,
          objectName: `${fileName}.mp4`,
          putObjectBody: fileStream,
          contentType: "video/mp4",
        };

        await objectStorageClient.putObject(uploadDetails);
        console.log(`Uploaded to Oracle: ${fileName}.mp4`);
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

// Route to serve MP4 files from Oracle Cloud
app.get("/download/:fileName", async (req, res) => {
  const { fileName } = req.params;

  try {
    const existsPrimary = await checkFileInBucket(BUCKET_PRIMARY, fileName);
    const existsUser = await checkFileInBucket(BUCKET_USER, fileName);

    if (!existsPrimary && !existsUser) {
      return res.status(404).json({ error: "File not found" });
    }

    const url = `https://objectstorage.${process.env.OCI_REGION}.oraclecloud.com/n/${namespace}/b/${existsPrimary ? BUCKET_PRIMARY : BUCKET_USER}/o/${fileName}.mp4`;

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