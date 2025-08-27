const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

// Security and rate limiting
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "ws:", "wss:"]
        }
    }
}));

app.use(cors());

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// In-memory storage for active users and messages
const activeUsers = new Map(); // socketId -> {username, joinTime, lastSeen}
const recentMessages = []; // Store recent messages for new users
const MAX_RECENT_MESSAGES = 50;
const bannedUsers = new Set(); // Store banned usernames
const userActivity = new Map(); // username -> {messageCount, lastMessage}

// Rate limiting for messages per user
const MESSAGE_RATE_LIMIT = 10; // messages per minute
const MESSAGE_WINDOW = 60 * 1000; // 1 minute

// Helper functions
function sanitizeMessage(message) {
    return message.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                 .replace(/[<>]/g, '')
                 .trim();
}

function sanitizeUsername(username) {
    return username.replace(/[<>]/g, '').trim();
}

function isValidUsername(username) {
    return username && 
           username.length >= 1 && 
           username.length <= 20 && 
           /^[a-zA-Z0-9\s_-]+$/.test(username) &&
           !bannedUsers.has(username.toLowerCase());
}

function isValidMessage(message) {
    return message && 
           message.length >= 1 && 
           message.length <= 500;
}

function checkMessageRateLimit(username) {
    const now = Date.now();
    if (!userActivity.has(username)) {
        userActivity.set(username, { messageCount: 1, lastMessage: now });
        return true;
    }
    
    const activity = userActivity.get(username);
    
    // Reset counter if window has passed
    if (now - activity.lastMessage > MESSAGE_WINDOW) {
        activity.messageCount = 1;
        activity.lastMessage = now;
        return true;
    }
    
    // Check if under limit
    if (activity.messageCount < MESSAGE_RATE_LIMIT) {
        activity.messageCount++;
        activity.lastMessage = now;
        return true;
    }
    
    return false;
}

function addRecentMessage(messageData) {
    recentMessages.push(messageData);
    if (recentMessages.length > MAX_RECENT_MESSAGES) {
        recentMessages.shift();
    }
}

function logActivity(action, username, socketId) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${action}: ${username} (${socketId})`);
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeUsers: activeUsers.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/api/stats', (req, res) => {
    res.json({
        activeUsers: activeUsers.size,
        recentMessages: recentMessages.length,
        bannedUsers: bannedUsers.size
    });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    
    // Send current online count to new connection
    socket.emit('onlineCount', activeUsers.size);
    
    // Handle user joining
    socket.on('join', (username) => {
        try {
            const sanitizedUsername = sanitizeUsername(username);
            
            if (!isValidUsername(sanitizedUsername)) {
                socket.emit('error', { 
                    message: 'Invalid username. Use 1-20 characters, letters, numbers, spaces, hyphens, and underscores only.' 
                });
                return;
            }
            
            // Check if username is already taken
            const existingUser = Array.from(activeUsers.values())
                .find(user => user.username.toLowerCase() === sanitizedUsername.toLowerCase());
            
            if (existingUser) {
                socket.emit('error', { 
                    message: 'Username is already taken. Please choose a different one.' 
                });
                return;
            }
            
            // Add user to active users
            activeUsers.set(socket.id, {
                username: sanitizedUsername,
                joinTime: new Date(),
                lastSeen: new Date(),
                socketId: socket.id
            });
            
            // Join the main chat room
            socket.join('main-chat');
            
            logActivity('USER_JOINED', sanitizedUsername, socket.id);
            
            // Notify all users about new user
            io.to('main-chat').emit('userJoined', {
                username: sanitizedUsername,
                onlineCount: activeUsers.size,
                timestamp: new Date().toISOString()
            });
            
            // Send recent messages to the new user
            recentMessages.forEach(message => {
                socket.emit('message', message);
            });
            
        } catch (error) {
            console.error('Error in join handler:', error);
            socket.emit('error', { message: 'An error occurred while joining the chat.' });
        }
    });
    
    // Handle new messages
    socket.on('message', (data) => {
        try {
            const user = activeUsers.get(socket.id);
            if (!user) {
                socket.emit('error', { message: 'You must join the chat first.' });
                return;
            }
            
            const sanitizedMessage = sanitizeMessage(data.message);
            
            if (!isValidMessage(sanitizedMessage)) {
                socket.emit('error', { message: 'Invalid message. Must be 1-500 characters.' });
                return;
            }
            
            // Check rate limit
            if (!checkMessageRateLimit(user.username)) {
                socket.emit('error', { 
                    message: 'You are sending messages too quickly. Please slow down.' 
                });
                return;
            }
            
            const messageData = {
                username: user.username,
                message: sanitizedMessage,
                timestamp: new Date().toISOString(),
                socketId: socket.id
            };
            
            // Add to recent messages
            addRecentMessage(messageData);
            
            // Update user's last seen
            user.lastSeen = new Date();
            
            // Broadcast message to all users in the main chat
            io.to('main-chat').emit('message', messageData);
            
            logActivity('MESSAGE_SENT', user.username, socket.id);
            
        } catch (error) {
            console.error('Error in message handler:', error);
            socket.emit('error', { message: 'An error occurred while sending the message.' });
        }
    });
    
    // Handle typing indicators
    socket.on('typing', (data) => {
        try {
            const user = activeUsers.get(socket.id);
            if (!user) return;
            
            socket.to('main-chat').emit('userTyping', {
                username: user.username,
                typing: data.typing
            });
            
        } catch (error) {
            console.error('Error in typing handler:', error);
        }
    });
    
    // Handle user idle status
    socket.on('userIdle', (username) => {
        try {
            const user = activeUsers.get(socket.id);
            if (user) {
                user.status = 'idle';
                logActivity('USER_IDLE', username, socket.id);
            }
        } catch (error) {
            console.error('Error in userIdle handler:', error);
        }
    });
    
    // Handle user active status
    socket.on('userActive', (username) => {
        try {
            const user = activeUsers.get(socket.id);
            if (user) {
                user.status = 'active';
                user.lastSeen = new Date();
                logActivity('USER_ACTIVE', username, socket.id);
            }
        } catch (error) {
            console.error('Error in userActive handler:', error);
        }
    });
    
    // Handle explicit leave
    socket.on('leave', (username) => {
        handleUserDisconnection(socket, 'USER_LEFT');
    });
    
    // Handle disconnection
    socket.on('disconnect', (reason) => {
        handleUserDisconnection(socket, 'USER_DISCONNECTED', reason);
    });
    
    // Handle connection errors
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
});

// Helper function to handle user disconnection
function handleUserDisconnection(socket, logType, reason = '') {
    try {
        const user = activeUsers.get(socket.id);
        if (user) {
            // Remove user from active users
            activeUsers.delete(socket.id);
            
            logActivity(logType, user.username, socket.id);
            if (reason) {
                console.log(`Reason: ${reason}`);
            }
            
            // Notify all users about user leaving
            socket.to('main-chat').emit('userLeft', {
                username: user.username,
                onlineCount: activeUsers.size,
                timestamp: new Date().toISOString()
            });
            
            // Clean up user activity if no recent messages
            const activity = userActivity.get(user.username);
            if (activity && Date.now() - activity.lastMessage > 5 * 60 * 1000) { // 5 minutes
                userActivity.delete(user.username);
            }
        }
    } catch (error) {
        console.error('Error in handleUserDisconnection:', error);
    }
}

// Periodic cleanup of inactive users
setInterval(() => {
    const now = new Date();
    const inactiveThreshold = 30 * 60 * 1000; // 30 minutes
    
    for (const [socketId, user] of activeUsers.entries()) {
        if (now - user.lastSeen > inactiveThreshold) {
            console.log(`Cleaning up inactive user: ${user.username}`);
            activeUsers.delete(socketId);
            
            io.to('main-chat').emit('userLeft', {
                username: user.username,
                onlineCount: activeUsers.size,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    // Clean up old user activity
    for (const [username, activity] of userActivity.entries()) {
        if (now - activity.lastMessage > 60 * 60 * 1000) { // 1 hour
            userActivity.delete(username);
        }
    }
}, 5 * 60 * 1000); // Run every 5 minutes

// Admin endpoints (basic implementation)
app.post('/api/admin/ban', (req, res) => {
    const { username, adminKey } = req.body;
    
    // Simple admin authentication (use proper auth in production)
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }
    
    bannedUsers.add(username.toLowerCase());
    
    // Disconnect banned user if online
    for (const [socketId, user] of activeUsers.entries()) {
        if (user.username.toLowerCase() === username.toLowerCase()) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.emit('error', { message: 'You have been banned from the chat.' });
                socket.disconnect(true);
            }
            break;
        }
    }
    
    res.json({ success: true, message: `User ${username} has been banned.` });
});

app.post('/api/admin/unban', (req, res) => {
    const { username, adminKey } = req.body;
    
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }
    
    bannedUsers.delete(username.toLowerCase());
    res.json({ success: true, message: `User ${username} has been unbanned.` });
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Process terminated');
        process.exit(0);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`🚀 Chat server running on port ${PORT}`);
    console.log(`📱 Access the chat at: http://localhost:${PORT}`);
    console.log(`📊 Health check at: http://localhost:${PORT}/api/health`);
    console.log(`📈 Stats at: http://localhost:${PORT}/api/stats`);
});