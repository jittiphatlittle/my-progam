require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const connectDB = require('./config/database');
const Log = require('./models/Log');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Routes - ลบ auth routes ออก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Redirect all unknown routes to index
app.get('*', (req, res) => {
    res.redirect('/');
});

// เริ่ม server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Local access: http://localhost:${PORT}`);
    
    // แสดง IP ทั้งหมดที่สามารถใช้เข้าถึงได้
    const networkInterfaces = require('os').networkInterfaces();
    for (const interfaceName of Object.keys(networkInterfaces)) {
        for (const interface of networkInterfaces[interfaceName]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                console.log(`Network access: http://${interface.address}:${PORT}`);
            }
        }
    }
    
    console.log('Note: To access from other networks, you may need to:');
    console.log('1. Configure your firewall to allow port', PORT);
    console.log('2. Set up port forwarding on your router');
    console.log('3. Use your public IP address');
    
    connectDB().catch(console.error);
});

// เก็บข้อมูลผู้ใช้ออนไลน์
const onlineUsers = new Set();

// เก็บคิวการจับคู่
const matchQueue = {
    m4: new Map(),
    m5: new Map(),
    m6: new Map()
};

// เพิ่มตัวแปรเก็บข้อความในห้องแชทรวม
const publicChatMessages = [];
const MAX_MESSAGES = 100; // จำกัดจำนวนข้อความที่เก็บ

// เก็บข้อมูลห้องแชท
const chatRooms = new Map();

// เพิ่มฟังก์ชันสำหรับบันทึกล็อก
async function logActivity(type, data, req) {
    try {
        const log = new Log({
            type: type,
            userId: data.userId || null,
            username: data.username || 'anonymous',
            details: data,
            ipAddress: req?.ip || data.ip,
            userAgent: req?.headers?.['user-agent'] || data.userAgent
        });
        await log.save();
    } catch (error) {
        console.error('Logging error:', error);
    }
}

// Socket.IO
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    onlineUsers.add(socket.id);

    // บันทึกการเชื่อมต่อ
    logActivity('login', {
        userId: socket.id,
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent']
    });

    // ส่งข้อมูลจำนวนผู้ใช้ออนไลน์
    io.emit('online_users', Array.from(onlineUsers));

    // รับคำขอข้อมูลผู้ใช้ออนไลน์
    socket.on('request_online_users', () => {
        socket.emit('online_users', Array.from(onlineUsers));
    });

    socket.on('chat_message', (message) => {
        io.emit('chat_message', {
            id: socket.id,
            message: message
        });

        // บันทึกการแชท
        logActivity('chat', {
            userId: socket.id,
            username: socket.userData?.username,
            message: message
        });
    });

    socket.on('find_match', (userData) => {
        console.log('Finding match for:', userData);
        
        socket.userData = userData;
        const gradeQueue = matchQueue[userData.grade];
        const startTime = Date.now();

        if (!gradeQueue) {
            console.error('Invalid grade:', userData.grade);
            return;
        }

        // เช็คคู่ที่เหมาะสม
        const matches = Array.from(gradeQueue.entries()).filter(([id, data]) => 
            data.subject === userData.subject && 
            data.role !== userData.role && 
            id !== socket.id
        );

        console.log('Available matches:', matches);

        if (matches.length > 0) {
            // เลือกคู่ที่รออยู่นานที่สุด
            const [partnerId, partnerData] = matches.reduce((oldest, current) => {
                return current[1].startTime < oldest[1].startTime ? current : oldest;
            }, matches[0]);

            // ลบคู่ออกจากคิว
            gradeQueue.delete(partnerId);
            
            // สร้าง matchId ที่ unique
            const matchId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const matchTime = (Date.now() - partnerData.startTime) / 1000;

            // ส่งข้อมูลให้ทั้งคู่
            const matchDataForPartner = {
                matchId: matchId,
                matchTime: matchTime,
                partnerName: userData.username,
                partnerRole: userData.role
            };

            const matchDataForUser = {
                matchId: matchId,
                matchTime: matchTime,
                partnerName: partnerData.username,
                partnerRole: partnerData.role
            };

            console.log('Matching users:', {
                user1: { id: socket.id, data: matchDataForUser },
                user2: { id: partnerId, data: matchDataForPartner }
            });

            // ส่งข้อมูลให้ทั้งสองฝ่าย
            socket.emit('match_found', matchDataForUser);
            io.to(partnerId).emit('match_found', matchDataForPartner);

            // สร้างห้องแชท
            chatRooms.set(matchId, {
                users: [socket.id, partnerId],
                messages: [],
                createdAt: new Date()
            });

        } else {
            // เพิ่มเข้าคิวถ้าไม่พบคู่
            gradeQueue.set(socket.id, {
                ...userData,
                startTime: startTime
            });
            console.log('Added to queue:', socket.id);
        }
    });

    socket.on('cancel_match', () => {
        if (socket.userData) {
            const gradeQueue = matchQueue[socket.userData.grade];
            if (gradeQueue) {
                gradeQueue.delete(socket.id);
                console.log('Cancelled match:', socket.id); // เพิ่ม log
            }
        }
    });

    // รับข้อความแชทรวม
    socket.on('public_message', (data) => {
        const messageData = {
            id: socket.id,
            username: socket.userData?.username || 'Anonymous',
            message: data,
            timestamp: new Date()
        };
        
        // เก็บข้อความและจำกัดจำนวน
        publicChatMessages.push(messageData);
        if (publicChatMessages.length > MAX_MESSAGES) {
            publicChatMessages.shift();
        }
        
        // ส่งข้อความไปยังทุกคน
        io.emit('new_public_message', messageData);
    });

    // ส่งประวัติข้อความเมื่อเข้าห้องแชทรวม
    socket.on('join_public_chat', () => {
        socket.emit('public_chat_history', publicChatMessages);
    });

    // เข้าร่วมห้องแชท
    socket.on('join_chat', ({ matchId }) => {
        socket.join(matchId);
        
        if (!chatRooms.has(matchId)) {
            chatRooms.set(matchId, {
                users: [socket.id],
                messages: []
            });
        } else {
            const room = chatRooms.get(matchId);
            room.users.push(socket.id);
            
            // ส่งข้อความประวัติให้ผู้เข้าร่วมใหม่
            socket.emit('chat_history', room.messages);
        }

        // แจ้งข้อมูลคู่แชท
        if (socket.userData) {
            io.to(matchId).emit('chat_connected', {
                partnerId: socket.id,
                partnerName: socket.userData.username
            });
        }
    });

    // รับและส่งข้อความในห้องแชท
    socket.on('chat_message', ({ matchId, message }) => {
        const messageData = {
            sender: socket.id,
            username: socket.userData?.username,
            message: message,
            timestamp: new Date()
        };

        const room = chatRooms.get(matchId);
        if (room) {
            room.messages.push(messageData);
            io.to(matchId).emit('chat_message', messageData);
            console.log('Chat message sent:', messageData); // เพิ่ม log
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        onlineUsers.delete(socket.id);
        io.emit('online_users', Array.from(onlineUsers));

        // บันทึกการตัดการเชื่อมต่อ
        logActivity('logout', {
            userId: socket.id,
            username: socket.userData?.username
        });

        // ลบออกจากคิวเมื่อตัดการเชื่อมต่อ
        if (socket.userData) {
            matchQueue[socket.userData.grade]?.delete(socket.id);
        }

        // ลบออกจากห้องแชท
        chatRooms.forEach((room, matchId) => {
            const index = room.users.indexOf(socket.id);
            if (index !== -1) {
                room.users.splice(index, 1);
                if (room.users.length === 0) {
                    chatRooms.delete(matchId);
                }
            }
        });
    });
});
