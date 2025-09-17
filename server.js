import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import bcrypt from "bcrypt";
import multer from "multer";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());
app.use(cors());

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  }
});
const upload = multer({ storage });

// =========================
// MongoDB Connection
// =========================
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connecté ✅"))
  .catch(err => console.error("Erreur MongoDB ❌:", err));

// =========================
// User Schema
// =========================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  latitude: { type: Number, default: 0 },
  longitude: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);

// =========================
// Marker Schema
// =========================
const markerSchema = new mongoose.Schema({
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  title: { type: String, default: "" },
  comment: { type: String, default: "" },
  color: { type: String, default: "#ff0000" },
  photos: { type: [String], default: [] },
  videos: { type: [String], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now }
});

const Marker = mongoose.model("Marker", markerSchema);

// =========================
// Routes
// =========================
app.get("/", (req, res) => res.send("API Temps Réel fonctionne ✅"));

// Lister tous les utilisateurs
app.get("/users", async (req, res) => {
  try {
    const users = await User.find({}, "-__v -password");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inscription
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "Email déjà utilisé" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await User.create({ name, email, password: hashedPassword });

    res.status(201).json({ user: { _id: newUser._id, name: newUser.name } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Connexion
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Email ou mot de passe incorrect" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Email ou mot de passe incorrect" });

    res.json({ user: { _id: user._id, name: user.name } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Ajouter un marqueur
app.post("/markers", upload.fields([{ name: "photos", maxCount: 10 }, { name: "videos", maxCount: 10 }]), async (req, res) => {
  try {
    const { latitude, longitude, title, comment, color, userId } = req.body;
    const photos = req.files.photos ? req.files.photos.map(f => `/uploads/${f.filename}`) : [];
    const videos = req.files.videos ? req.files.videos.map(f => `/uploads/${f.filename}`) : [];

    const newMarker = await Marker.create({
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      title,
      comment,
      color,
      photos,
      videos,
      createdBy: userId || null
    });

    io.emit("newMarker", newMarker);
    console.log(`Marqueur ajouté: [${latitude}, ${longitude}] avec titre "${title}"`);
    res.status(201).json(newMarker);
  } catch (err) {
    console.error("Erreur addMarker:", err);
    res.status(500).json({ message: err.message });
  }
});

// Éditer un marqueur
app.patch("/markers/:id", upload.fields([{ name: "photos", maxCount: 10 }, { name: "videos", maxCount: 10 }]), async (req, res) => {
  try {
    const { title, comment, color } = req.body;
    const marker = await Marker.findById(req.params.id);
    if (!marker) return res.status(404).json({ message: "Marqueur non trouvé" });

    if (title !== undefined) marker.title = title;
    if (comment !== undefined) marker.comment = comment;
    if (color !== undefined) marker.color = color;

    if (req.files.photos) {
      const newPhotos = req.files.photos.map(f => `/uploads/${f.filename}`);
      marker.photos = [...marker.photos, ...newPhotos];
    }
    if (req.files.videos) {
      const newVideos = req.files.videos.map(f => `/uploads/${f.filename}`);
      marker.videos = [...marker.videos, ...newVideos];
    }

    await marker.save();
    io.emit("updatedMarker", marker);
    console.log(`Marqueur mis à jour: ID ${req.params.id} avec titre "${title}"`);
    res.json(marker);
  } catch (err) {
    console.error("Erreur editMarker:", err);
    res.status(500).json({ message: err.message });
  }
});

// =========================
// Socket.IO positions temps réel
// =========================
io.on("connection", (socket) => {
  console.log("Nouvel utilisateur connecté:", socket.id);

  const sendAllMarkers = async () => {
    try {
      const markers = await Marker.find();
      socket.emit("allMarkers", markers);
    } catch (err) {
      console.error("Erreur envoi marqueurs:", err);
    }
  };
  sendAllMarkers();

  socket.on("updatePosition", async ({ userId, latitude, longitude }) => {
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      console.warn("Coordonnées invalides reçues:", latitude, longitude);
      return;
    }

    try {
      const user = await User.findByIdAndUpdate(
        userId,
        { latitude, longitude },
        { new: true }
      );

      if (user) {
        io.emit("positionsUpdate", {
          userId: user._id,
          name: user.name,
          latitude: user.latitude,
          longitude: user.longitude
        });
        console.log(`Position mise à jour pour ${user.name}: [${latitude}, ${longitude}]`);
      }
    } catch (err) {
      console.error("Erreur updatePosition:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("Utilisateur déconnecté:", socket.id);
  });
});

// =========================
// Start Server
// =========================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server démarré sur le port ${PORT} 🚀`));