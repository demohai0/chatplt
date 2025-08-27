let socket;
let currentUsername = '';

// DOM Elements
const welcomeScreen = document.getElementById('welcomeScreen');
const chatScreen = document.getElementById('chatScreen');
const usernameInput = document.getElementById('usernameInput');
const startChatBtn = document.getElementById('startChatBtn');
const messagesContainer = document.getElementById('messagesContainer');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const onlineCount = document.getElementById('onlineCount');
const notificationContainer = document.getElementById('notificationContainer');

// Initialize socket connection
function initializeSocket() {
    socket = io();
    
    // Socket event listeners
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('userJoined', (data) => {
        updateOnlineCount(data.onlineCount);
        if (data.username !== currentUsername) {
            showNotification(`${data.username} joined the chat`, 'join');
            addSystemMessage(`${data.username} joined the chat`);
        }
    });
    
    socket.on('userLeft', (data) => {
        updateOnlineCount(data.onlineCount);
        if (data.username !== currentUsername) {
            showNotification(`${data.username} left the chat`, 'leave');
            addSystemMessage(`${data.username} left the chat`);
        }
    });
    
    socket.on('message', (data) => {
        addMessage(data.username, data.message, data.timestamp, data.username === currentUsername);
    });
    
    socket.on('onlineCount', (count) => {
        updateOnlineCount(count);
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showNotification('Connection lost. Trying to reconnect...', 'error');
    });
    
    socket.on('reconnect', () => {
        console.log('Reconnected to server');
        showNotification('Reconnected successfully!', 'success');
        if (currentUsername) {
            socket.emit('join', currentUsername);
        }
    });
}

// Event Listeners
startChatBtn.addEventListener('click', startChat);
usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        startChat();
    }
});

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

// Functions
function startChat() {
    const username = usernameInput.value.trim();
    
    if (!username) {
        usernameInput.focus();
        usernameInput.style.borderColor = '#ff6b6b';
        setTimeout(() => {
            usernameInput.style.borderColor = '';
        }, 2000);
        return;
    }
    
    if (username.length > 20) {
        alert('Username must be 20 characters or less');
        return;
    }
    
    currentUsername = username;
    
    // Initialize socket connection
    initializeSocket();
    
    // Hide welcome screen and show chat screen
    welcomeScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
    
    // Join the chat
    socket.emit('join', username);
    
    // Focus on message input
    messageInput.focus();
    
    // Add welcome message
    addSystemMessage(`Welcome to the chat, ${username}!`);
}

function sendMessage() {
    const message = messageInput.value.trim();
    
    if (!message || !socket) {
        return;
    }
    
    if (message.length > 500) {
        alert('Message must be 500 characters or less');
        return;
    }
    
    // Send message to server
    socket.emit('message', {
        username: currentUsername,
        message: message,
        timestamp: new Date().toISOString()
    });
    
    // Clear input
    messageInput.value = '';
    messageInput.focus();
}

function addMessage(username, message, timestamp, isOwn = false) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isOwn ? 'own' : ''}`;
    
    const time = new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
    });
    
    messageDiv.innerHTML = `
        <div class="message-bubble">
            ${!isOwn ? `<div class="message-author">${escapeHtml(username)}</div>` : ''}
            <div class="message-text">${escapeHtml(message)}</div>
            <div class="message-time">${time}</div>
        </div>
    `;
    
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function addSystemMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'system-message';
    messageDiv.textContent = message;
    
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function updateOnlineCount(count) {
    onlineCount.textContent = count;
    
    // Add animation effect
    onlineCount.style.transform = 'scale(1.2)';
    setTimeout(() => {
        onlineCount.style.transform = 'scale(1)';
    }, 200);
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    notificationContainer.appendChild(notification);
    
    // Remove notification after 4 seconds
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 4000);
}

function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Handle page refresh/close
window.addEventListener('beforeunload', () => {
    if (socket && currentUsername) {
        socket.emit('leave', currentUsername);
    }
});

// Handle visibility change (when user switches tabs)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // User switched away from the tab
        if (socket && currentUsername) {
            socket.emit('userIdle', currentUsername);
        }
    } else {
        // User came back to the tab
        if (socket && currentUsername) {
            socket.emit('userActive', currentUsername);
        }
    }
});

// Auto-focus on username input when page loads
window.addEventListener('load', () => {
    usernameInput.focus();
});

// Add typing indicator functionality
let typingTimer;
const typingDelay = 1000; // 1 second

messageInput.addEventListener('input', () => {
    if (socket && currentUsername) {
        socket.emit('typing', { username: currentUsername, typing: true });
        
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
            socket.emit('typing', { username: currentUsername, typing: false });
        }, typingDelay);
    }
});

// Handle typing indicators
let typingUsers = new Set();

socket && socket.on('userTyping', (data) => {
    if (data.username !== currentUsername) {
        if (data.typing) {
            typingUsers.add(data.username);
        } else {
            typingUsers.delete(data.username);
        }
        updateTypingIndicator();
    }
});

function updateTypingIndicator() {
    const existingIndicator = document.querySelector('.typing-indicator');
    if (existingIndicator) {
        existingIndicator.remove();
    }
    
    if (typingUsers.size > 0) {
        const indicator = document.createElement('div');
        indicator.className = 'typing-indicator system-message';
        
        const userList = Array.from(typingUsers);
        let text;
        
        if (userList.length === 1) {
            text = `${userList[0]} is typing...`;
        } else if (userList.length === 2) {
            text = `${userList[0]} and ${userList[1]} are typing...`;
        } else {
            text = `${userList.length} people are typing...`;
        }
        
        indicator.innerHTML = `
            <span>${escapeHtml(text)}</span>
            <span class="typing-dots">
                <span>.</span>
                <span>.</span>
                <span>.</span>
            </span>
        `;
        
        messagesContainer.appendChild(indicator);
        scrollToBottom();
    }
}