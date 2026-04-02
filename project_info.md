Project Overview: LiteMeet
1. Vision and Purpose
LiteMeet is an ultra-low-bandwidth virtual classroom platform specifically optimized for unstable or slow network conditions, such as 2G and 3G mobile data. The core goal is to provide a seamless educational experience (video, audio, and interactive tools) even at speeds as low as 6kbps.

2. Core Features
Adaptive WebRTC Video/Audio: Uses peer-to-peer connections with adaptive Opus VBR bitrate, adjusting from 128kbps on 4G down to 6kbps on 2G.

Interactive Whiteboard: A real-time synchronized drawing board that uses tiny "vector packets" (roughly 52–80 bytes) instead of heavy screen-sharing data.

Host Spotlight: A specialized layout where the teacher's (host) video is dominant for students, while other participants are moved to a secondary "peer strip" to save screen space and focus.

AI Upscaling: Features Edge-AI upscaling to improve 320p video to 720p directly on the user's device.

Real-time Subtitles: Integrated simulation for multi-language subtitles (supporting English and various Indian languages like Hindi, Tamil, and Telugu) to assist learning.

Classroom Management Tools: Includes real-time chat, vote-aggregated polls, document sharing (PDF/Images) with synchronized annotations, and session recording.

Audio Visualizer: Visual feedback through a glowing "speaking" ring around active participants to identify who is talking without needing high-quality audio.

3. Technical Architecture
The project follows a Signalling + Peer-to-Peer model:

Signalling Server (server.js): A Node.js server using Express and Socket.io. It does not handle the video data itself; instead, it acts as a "matchmaker" to help participants find each other, exchange room information (via PINs), and relay lightweight data like whiteboard strokes and chat.

WebRTC Client (webrtc-client.js): The client-side logic that handles the heavy lifting of direct peer-to-peer media streaming. It manages ICE candidates (to bypass firewalls) and dynamically adjusts stream quality based on network profiles.

Frontend (lite-meet1.html): A single-file interface containing the CSS (styling), HTML (structure), and the UI-logic that connects the user’s interactions to the WebRTC and Signalling modules.

4. File Structure
server.js: The "brain" of the backend that manages rooms and relays data.

webrtc-client.js: The module for managing peer connections and bitrate.

lite-meet1.html: The full frontend interface for the classroom.

package.json: Lists necessary dependencies like express, socket.io, and dotenv.

.env: A configuration file for settings like the PORT and CLIENT_ORIGIN.

5. Setup and Execution
To run the project locally, follow these steps in your terminal:

Install dependencies: npm install.

Configure environment: Create a .env file with PORT=3000.

Start the server: node server.js.

Access the app: Open Chrome and navigate to http://localhost:3000/lite-meet.html.