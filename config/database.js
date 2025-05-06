const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect('mongodb://127.0.0.1:27017/trytutor_db', {
            serverSelectionTimeoutMS: 5000,
            maxPoolSize: 10
        });
        console.log('Connected to MongoDB: trytutor_db');
        
        // กำหนด collections และโครงสร้างเริ่มต้น (ลบ users collection ออก)
        const collections = {
            matches: {
                name: "การจับคู่",
                fields: ['student_id', 'tutor_id', 'subject', 'status']
            },
            chats: {
                name: "ประวัติการแชท",
                fields: ['sender_id', 'receiver_id', 'message', 'timestamp']
            },
            subjects: {
                name: "รายวิชา",
                fields: ['subject_code', 'subject_name', 'description']
            }
        };

        // สร้าง collections
        const db = mongoose.connection.db;
        
        for (const [key, value] of Object.entries(collections)) {
            const exists = await db.listCollections({name: key}).hasNext();
            if (!exists) {
                await db.createCollection(key);
                console.log(`Created collection: ${value.name} (${key})`);
            }
        }

    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
};

module.exports = connectDB;
