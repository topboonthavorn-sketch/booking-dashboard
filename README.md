# Boonthavorn Booking Dashboard

Real-time admin dashboard แสดงคิวนัดหมายจาก Calendly (รองรับแพลนฟรีด้วย API polling, พร้อม webhook endpoint สำหรับแพลนเสียเงิน)

## Deploy บน Render
1. Push โค้ดนี้ขึ้น GitHub
2. Render → **New Web Service** → เลือก repo นี้
3. ตั้งค่า: Build `npm install` · Start `node server.js` · Plan Free
4. Environment variables:

| ตัวแปร | จำเป็น | คำอธิบาย |
|---|---|---|
| `CALENDLY_TOKEN` | แนะนำ | Personal Access Token จาก Calendly → Integrations → API & Webhooks (ไม่ใส่ = โหมด demo/mock) |
| `DASHBOARD_PASSWORD` | แนะนำ | รหัสผ่านหน้า dashboard (Basic auth, username อะไรก็ได้) |
| `POLL_SECONDS` | ไม่ | ความถี่ดึงข้อมูล (default 45 วิ, ต่ำสุด 20) |

## วิธีได้ CALENDLY_TOKEN (แพลนฟรีใช้ได้)
Calendly → Account Settings → **Integrations & apps** → **API & webhooks** → Generate personal access token → คัดลอกไปใส่ใน Render env var

## Endpoints
- `/` — dashboard
- `/api/bookings` — JSON คิววันนี้ (เวลาไทย)
- `/api/stream` — Server-Sent Events (real-time)
- `POST /webhook/calendly` — สำหรับ Calendly webhook (แพลนเสียเงิน) → refresh ทันที
- `/healthz` — health check

## Logo
วางไฟล์โลโก้ชื่อ `logo.png` ที่ root ของ repo (ถ้าไม่มี จะแสดงชื่อแบรนด์เป็นข้อความแทน)

## รันในเครื่อง
```bash
npm install
CALENDLY_TOKEN=xxx node server.js   # เปิด http://localhost:3000
```

## หมายเหตุ
- แพลนฟรี Calendly ใช้ webhook ไม่ได้ → ระบบใช้ polling ทุก 45 วิ (real-time หน่วงสูงสุด ~45 วิ)
- อัปเกรดแพลนเมื่อไหร่ สร้าง webhook subscription ชี้มาที่ `/webhook/calendly` จะเด้งทันทีที่มีคนจอง
- Render free tier จะ sleep เมื่อไม่มีคนเปิด — เปิดหน้าเว็บครั้งแรกอาจรอ ~30 วิ
