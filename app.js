const express = require('express');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs'); 
const prisma = new PrismaClient();

const app = express();

// Session config
app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: true
}));

// Set view engine to EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Middleware 
app.use(express.urlencoded({ extended: true }));

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// Middleware to check if the user is logged in
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    res.redirect('/login');
  } else {
    next();
  }
}

// Middleware to restrict access to index page for logged-in users
function restrictIndex(req, res, next) {
  if (req.session.userId) {
    return res.redirect('/file-upload'); 
  }
  next();
}

// Route to render home page (only if logged out)
app.get('/', restrictIndex, (req, res) => {
  res.render('index', { session: req.session });
});

// Route for file upload page (only if logged in)
app.get('/file-upload', requireLogin, async (req, res) => {
  const files = await prisma.file.findMany({
    where: { userId: req.session.userId }
  });
  res.render('file-upload', { files, session: req.session });
});

// Route to handle file uploads
app.post('/upload', requireLogin, upload.single('file'), async (req, res) => {
  const { file } = req;
  const userId = req.session.userId;

  if (!file) {
    return res.status(400).send('No file uploaded.');
  }

  await prisma.file.create({
    data: {
      filename: file.originalname,
      mimetype: file.mimetype,
      path: file.path,
      userId: userId
    }
  });

  res.redirect('/file-upload');
});

// Route to handle file renaming
app.post('/rename/:id', requireLogin, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;
  const { newName } = req.body;

  const file = await prisma.file.findUnique({
    where: { id: fileId }
  });

  if (!file || file.userId !== userId) {
    return res.status(403).send('You are not authorized to rename this file.');
  }

  const fileExtension = file.filename.split('.').pop();
  const updatedFilename = `${newName}.${fileExtension}`;

  await prisma.file.update({
    where: { id: fileId },
    data: {
      filename: updatedFilename
    }
  });

  res.redirect('/file-upload');
});

// Route to handle file deletion
app.post('/delete/:id', requireLogin, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  const file = await prisma.file.findUnique({
    where: { id: fileId }
  });

  if (!file || file.userId !== userId) {
    return res.status(403).send('You are not authorized to delete this file.');
  }

  await prisma.file.delete({
    where: { id: fileId }
  });

  res.redirect('/file-upload');
});

// Route to download files
app.get('/download/:id', requireLogin, async (req, res) => {
  const fileId = parseInt(req.params.id);
  const userId = req.session.userId;

  const file = await prisma.file.findUnique({
    where: { id: fileId }
  });

  if (!file || file.userId !== userId) {
    return res.status(403).send('You are not authorized to download this file.');
  }

  res.download(file.path, file.filename);
});

// Profile route
app.get('/profile', requireLogin, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.session.userId },
    include: {
      files: true
    }
  });

  res.render('profile', { user });
});

// Route to change the password
app.post('/profile/change-password', requireLogin, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.session.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  const passwordMatch = await bcrypt.compare(currentPassword, user.password);

  if (!passwordMatch) {
    return res.status(400).send('Das aktuelle Passwort ist nicht korrekt.');
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  await prisma.user.update({
    where: { id: userId },
    data: {
      password: hashedPassword
    }
  });

  res.redirect('/profile');
});

// Route to delete the user account and all data
app.post('/delete-account', requireLogin, async (req, res) => {
  const userId = req.session.userId;

  // Delete user files from the database and filesystem
  const userFiles = await prisma.file.findMany({
    where: { userId: userId }
  });

  // Delete files from filesystem
  userFiles.forEach(file => {
    fs.unlink(file.path, (err) => {
      if (err) {
        console.error(`Error deleting file ${file.path}:`, err);
      }
    });
  });

  // Delete files from the database
  await prisma.file.deleteMany({
    where: { userId: userId }
  });

  // Delete the user account
  await prisma.user.delete({
    where: { id: userId }
  });

  // Destroy session and log out the user
  req.session.destroy();

  res.redirect('/sign-up');
});

// Login route
app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) {
    return res.status(400).send('Invalid credentials.');
  }

  const passwordMatch = await bcrypt.compare(password, user.password);

  if (!passwordMatch) {
    return res.status(400).send('Invalid credentials.');
  }

  req.session.userId = user.id;
  res.redirect('/file-upload'); // Redirect to file upload page after login
});

// Sign-up route
app.get('/sign-up', (req, res) => {
  res.render('sign-up');
});

app.post('/sign-up', async (req, res) => {
  const { email, password, name } = req.body;

  const existingUser = await prisma.user.findUnique({
    where: { email }
  });

  if (existingUser) {
    return res.status(400).send('User with this email already exists.');
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      name
    }
  });

  req.session.userId = user.id;
  res.redirect('/file-upload'); // Redirect to file upload after sign-up
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
