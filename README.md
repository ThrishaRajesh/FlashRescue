# FlashRescue: A Resilient Smart-City Platform and Safe Evacuation Guidance

> **Recognition**
>
> - Research paper presented at **ICSDSA 2026 (International Conference on Secure Data Science and Applications)**, a **SCOPUS-indexed Springer conference**.
> - Selected under the **Indian Patent Publication Category** following peer review for its innovation and real-world applicability.
> - **Second Prize** at the **K-GIS 2.0 State-Level Exhibition & Student Innovation Model Competition (KSRSAC, Government of Karnataka)** for the FlashRescue platform.

---

## Project Overview

**FlashRescue** is an AI-powered disaster intelligence platform that integrates IoT sensing, multimodal artificial intelligence, digital twins, trust-aware data fusion, and predictive risk analytics to support rapid emergency response and safe evacuation during floods, fires, earthquakes, and other urban disasters.

The platform continuously collects sensor observations, validates citizen reports, predicts hazard propagation, recommends safe evacuation routes, and coordinates volunteers through a live command dashboard.

The system provides:
- **Real-time hazard detection** via distributed sensor networks
- **Multimodal incident triage** using vision transformers, fire-detection models, and speech recognition
- **Trust-scored data fusion** that validates citizen reports against sensor readings
- **Dynamic risk prediction** with hazard-aware evacuation routing
- **Live operational dashboard** for command-and-control coordination
- **Volunteer assignment and micro-task allocation** with real-time telemetry updates

---

## Team

| Role | Contributor | Focus |
|------|-------------|-------|
| **IoT & Risk Prediction** | **Thrisha R** | Sensor networks, dynamic grid-based risk forecasting, evacuation routing |
| **AI & Multimodal Triage** | **Vismaya M** | Vision models, disaster classification, hazard-aware routing, digital twin |
| **AI & Data Fusion** | **Yashaswini K M** | Trust scoring, data fusion, micro-task generation, volunteer allocation |

---

## Technology Stack

| Category        | Technologies                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| Languages       | Python, JavaScript, HTML, CSS                                                 |
| AI / ML         | PyTorch, TorchVision, HuggingFace Transformers, OpenCV, Whisper, Scikit-learn |
| Computer Vision | Vision Transformer (ViT), ResNet-50, Fire & Smoke Detection CNN               |
| NLP             | Whisper ASR, Disaster Text Classification                                     |
| IoT             | MQTT, Mosquitto                                                               |
| Mapping         | Leaflet.js                                                                    |
| Algorithms      | A* Pathfinding, Grid Diffusion, Temporal Smoothing, Trust Scoring             |
| Backend         | Node.js                                                                       |
| Notifications   | Twilio SMS & Voice                                                            |
| Architecture    | Digital Twin, Event-driven Microservices                                      |

----

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        FlashRescue Platform                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │  IoT Layer      │  │   AI Layer       │  │  Fusion Layer    │ │
│  ├─────────────────┤  ├──────────────────┤  ├──────────────────┤ │
│  │• Sensors        │  │• Vision Models   │  │• Trust Scoring   │ │
│  │• Volunteers GPS │  │• Speech ASR      │  │• Evidence Link   │ │
│  │• Risk Grid      │  │• Fire Detection  │  │• Consensus Logic │ │
│  └─────────────────┘  └──────────────────┘  └──────────────────┘ │
│         ↓                      ↓                      ↓            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │         MQTT Broker (Event Stream)                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│         ↓                      ↓                      ↓            │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │ Risk Predictor  │  │ Alert Service    │  │ Route Planner    │ │
│  │ (Diffusion +    │  │ (Twilio SMS/Call)│  │ (A* Pathfinding) │ │
│  │  Forecasting)   │  │                  │  │                  │ │
│  └─────────────────┘  └──────────────────┘  └──────────────────┘ │
│         ↓                      ↓                      ↓            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Command Dashboard (Leaflet Map + Live Visualization)      │ │
│  │  • Volunteer tracking, risk heatmaps, evacuation routes    │ │
│  │  • Crowd validation, trust layer, micro-task dispatch      │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## System Workflow

IoT Sensors
        │
Citizen Reports
        │
        ▼
 MQTT Event Broker
        │
        ▼
Multimodal AI
(ViT + ResNet + Whisper)
        │
        ▼
Trust Scoring &
Evidence Fusion
        │
        ▼
Risk Prediction
(Grid Diffusion)
        │
        ▼
Hazard-aware
A* Routing
        │
        ▼
Digital Twin Dashboard
        │
        ▼
Volunteer Coordination

---

## Core Features & Methods

### 1. Multimodal Triage System

Disaster incident classification and severity assessment from diverse input streams:
- GPS locations & timestamps
- Free-text reports  
- Images & video feeds
- Automatic speech recognition (ASR) transcriptions

**Process**:
1. Recognize disaster categories (flood, fire, structure collapse, etc.)
2. Measure severity and validate consistency across modalities
3. Group duplicate/similar reports by location, timing, and visual similarity
4. Generate verified incident records with location, severity, category, and supporting evidence

---

### 2. Trust-Scored Data Fusion

Validates and fuses evidence from disparate sources—sensor networks and citizen reports:
- **Link Establishment**: Geographical proximity, chronological correlation, condition agreement
- **Trust Calculation**: Classifier confidence, source consistency, supporting report count, historical reliability
- **Inconsistency Handling**: Low-confidence clusters request additional evidence or receive reduced decision weight

---

### 3. Next Risk Zone Prediction

Dynamic real-time hazard mapping and forecasting:
- **Data Ingestion**: Rainfall, water level, fire signals from distributed sensor grid
- **Normalization & Smoothing**: Standardize readings, weight by severity, apply temporal smoothing
- **Trend Analysis**: Identify intensity increases in hotspots
- **Diffusion Prediction**: Compute hazard spread across adjacent grid cells
- **Downstream Use**: Short-range forecasts guide routing and volunteer priorities

---

### 4. Micro Task Generation & Allocation

Breakdown high-level relief needs into actionable, scoped tasks:
- **Assignment Methods**:
  - *Distance-based*: Fast heuristic assignment
  - *Weighted-score*: Considers volunteer skills, safety constraints, priorities
- **Live Updates**: Telemetry (speed, congestion) continuously refine assignments

---

### 5. Hazard-Aware Routing & Evacuation

Intelligent pathfinding for safe, rapid evacuation:
- **Graph Representation**: Roads model as dynamic graph with edge costs
- **Cost Factors**: Congestion, obstruction, hazard severity, uncertainty
- **Algorithm**: A* pathfinding with risk-weighted traversal costs
- **Output**: Best route, hazard warnings, dynamic alternatives

---

### 6. Digital Twin & Observability

Real-time situational awareness dashboard:
- **Live Elements**: Volunteer positions, hospitals, shelters, blocked roads, risk heatmaps
- **Hazard Visualization**: Predicted danger zones, ongoing tasks
- **Confidence Adjustment**: Field confirmations and task closures refine confidence scores
- **Operational Telemetry**: Latency, throughput, reroute frequency metrics

---

## AI & ML Models

### Pretrained Vision & Multimodal Models

| Model | Purpose | Architecture | Input | Output |
|-------|---------|--------------|-------|--------|
| **Vision Transformer (ViT)** | Scene interpretation (debris, flooding, structural damage) | Transformer-based vision model | RGB images | Scene understanding logits |
| **Fire & Smoke Detector** | High-priority fire identification | Specialized CNN | RGB images | Fire/smoke confidence scores |
| **ResNet-50** | Prediction stabilization & ensemble robustness | Deep residual CNN | RGB images | Classification logits |
| **Whisper ASR** | Speech-to-text transcription from audio reports | Automatic Speech Recognition | Audio waveforms | Transcribed text |
| **Text Classifier** | Disaster cue extraction from transcripts | Lightweight NLP classifier | Text | Disaster type & cues |

**Fusion Strategy**: Image confidence + transcript signals → Final triage judgment (disaster type, risk level, confidence score)

---

## IoT Sensor Network

### Sensor Types & Normalization

| Sensor Type | Raw Unit | Max Normal Range | Normalization Formula | Threshold | Use Case |
|-------------|----------|------------------|----------------------|-----------|----------|
| **Rainfall** | mm/interval | 0–100 mm | `min(1, value / 100)` | 0.6 | Flood risk detection |
| **Water Level** | meters | 0–3 m | `min(1, value / 3)` | 0.95 | High-water alert |
| **Tremor/Seismic** | magnitude | 0–1 scale | `min(1, value / 1)` | 0.7 | Earthquake/landslide |
| **SOS Signal** | boolean | N/A | 1.0 if triggered | 1.0 | Emergency alert |

**Grid Configuration**:
- **Center**: Assam, Brahmaputra Basin (26.2006°N, 92.9376°E)
- **Grid Size**: 40×40 cells (configurable)
- **Spatial Coverage**: 0.12° lat × 0.12° lon (~13.3 km × 11.2 km)
- **Publishing Interval**: 2 seconds (configurable)

**Risk Calculation**:
```
updated_risk = SMOOTH_ALPHA × normalized_observation + (1 - SMOOTH_ALPHA) × previous_risk
forecasted_risk = DECAY × current_risk + DIFFUSION_COEFF × neighbor_average
```

**Key Parameters**:
| Parameter | Default | Purpose |
|-----------|---------|---------|
| `SMOOTH_ALPHA` | 0.6 | Temporal smoothing weight |
| `DECAY` | 0.92 | Risk decay per forecast step |
| `DIFF_COEFF` | 0.25 | Spatial diffusion factor |
| `RISK_THRESHOLD_ZONE` | 0.6 | High-risk zone detection threshold |
| `ROUTE_RISK_WEIGHT` | 9.0 | A* cost weight for hazard avoidance |

---

## Core Innovations

- Multimodal disaster intelligence pipeline
- Trust-aware sensor–citizen data fusion
- Grid-based hazard propagation modelling
- Digital Twin–enabled emergency visualization
- Risk-aware evacuation routing using A*
- Dynamic volunteer task orchestration
- Real-time IoT event streaming

---
<img width="1536" height="1024" alt="ChatGPT Image Jul 13, 2026, 09_41_22 PM" src="https://github.com/user-attachments/assets/ea674326-5432-4e7b-8000-40b6d0f518f1" />

## Project Structure

```
FlashRescue/
├── IoT/
│   ├── Publishers/
│   │   ├── sensor_sim.cjs          # Simulated sensor grid (rainfall, water level)
│   │   └── volunteer_sim.cjs       # Volunteer GPS & velocity vector publisher
│   │
│   ├── Subscribers/
│   │   ├── risk_predictor.cjs      # Grid-based risk forecasting, diffusion, A* routing
│   │   └── alert_service.cjs       # Alert generation, Twilio SMS/voice, rate limiting
│   │
│   └── Visualization Dashboard/
│       ├── dashboard.html          # Interactive Leaflet map, risk heatmaps, volunteer tracking
│       └── crowd_validation.html    # Trust layer demo, citizen report validation
│
├── AI/
│   ├── multimodal_triage.py        # Vision models, ASR, text classification, score fusion
│   ├── data_fusion.py              # Trust scoring, evidence linking, consensus logic
│   └── route_optimization.py       # Hazard-aware routing integration
│
└── README.md                        # This file
```

---

## Quick Start

### Prerequisites
- **Node.js** (v14+) for IoT services
- **Python** (3.9+) for AI modules
- **MQTT Broker** (e.g., Mosquitto) on `localhost:1883`
- **WebSocket Bridge** (e.g., mqtt-ws) on `localhost:9001`

### Installation

```bash
# Clone repository
git clone https://github.com/ThrishaRajesh/FlashRescue.git
cd FlashRescue

# Install Node dependencies (IoT services)
cd IoT
npm install mqtt twilio

# Install Python dependencies (AI modules)
cd ../AI
pip install torch torchvision transformers opencv-python openai-whisper scikit-learn

# Start MQTT broker
mosquitto -c /path/to/mosquitto.conf

# Start WebSocket bridge for dashboard
mqtt-ws localhost:1883 ws://0.0.0.0:9001
```

### Running the System

```bash
# Terminal 1: Start sensor simulator
cd IoT/Publishers
node sensor_sim.cjs

# Terminal 2: Start volunteer simulator
node volunteer_sim.cjs

# Terminal 3: Start risk predictor (grid + forecasting)
cd IoT/Subscribers
node risk_predictor.cjs

# Terminal 4: Start alert service (Twilio integration)
node alert_service.cjs

# Terminal 5: Start AI services
cd AI
python multimodal_triage.py
python data_fusion.py

# Terminal 6: Open dashboard
# Navigate to: http://localhost:8080/IoT/Visualization\ Dashboard/dashboard.html
```

---

## Dashboard Features

### Map Visualization
- **Risk Heatmap**: Real-time probability distribution of hazards
- **Sensor Nodes**: IoT sensor locations and latest readings
- **Volunteer Markers**: GPS-tracked responders with movement vectors
- **Evacuation Routes**: A*-computed safe paths with hazard avoidance
- **Risk Zones**: Convex hull polygons of high-risk clusters

### Control Panel
- Toggle layers (heat, sensors, volunteers, flow vectors)
- Assign volunteers to active high-risk zones
- Request evacuation routes (right-click on map)
- View live sensor data and volunteer telemetry
- Replay risk forecasts with visual animation

### Interactive Elements
- **Crowd Validation Panel**: Cross-verify citizen reports vs. sensor data
- **Trust Scores**: Confidence metrics for each verified incident
- **Micro-Task Dispatch**: Assign and track relief activities
- **Real-time Metrics**: Volunteer count, sensor count, system latency

---

## Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| **Sensor Heartbeat** | 2 sec | MQTT pub interval |
| **Risk Grid Update** | 1 sec | Continuous forecasting |
| **Route Computation** | <200 ms | A* with 1600 cells |
| **Alert Latency** | <500 ms | Risk zone detection to alert dispatch |
| **Dashboard Sync** | <100 ms | WebSocket message delivery |
| **Volunteer Track Update** | 2 sec | GPS positions published and visualized |

---

## Security & Privacy

- **MQTT Authentication**: Broker-level access control (configurable)
- **Data Minimization**: Only location, timestamp, and sensor type retained
- **Volunteer Anonymity**: ID-based tracking without PII
- **Encryption**: TLS for MQTT and WebSocket connections (production)
- **Rate Limiting**: Alert suppression (5-min cooldown per zone) prevents notification spam

---

## Configuration

All services respect environment variables for customization:

```bash
# IoT Services
export MQTT_BROKER="mqtt://localhost:1883"
export CENTER_LAT="26.2006"
export CENTER_LON="92.9376"
export GRID_ROWS="40"
export GRID_COLS="40"
export SMOOTH_ALPHA="0.6"
export DECAY="0.92"
export DIFF_COEFF="0.25"

# Alert Service (Twilio)
export TWILIO_SID="your_sid"
export TWILIO_AUTH_TOKEN="your_token"
export TWILIO_FROM="+1234567890"

# AI Services
export MODEL_DEVICE="cuda"  # or 'cpu'
export CONFIDENCE_THRESHOLD="0.75"
```

---

## Research & Publication

**Paper:** *"FlashRescue: A Resilient Smart-City Platform and Safe Evacuation Guidance"*

- **Conference:** International Conference on Secure Data Science and Applications (**ICSDSA 2026**)
- **Publication:** SCOPUS-indexed Springer Conference Proceedings
- **Presentation:** Successfully presented virtually on **28 March 2026**
- **Recognition:** Selected under the **Indian Patent Publication Category** following peer review

**Key Contributions**:
1. Integrated multimodal disaster triage pipeline
2. Trust-scored sensor-citizen data fusion framework
3. Real-time grid-based risk prediction with diffusion modeling
4. Hazard-aware evacuation routing with A* optimization
5. Production-ready smart-city coordination platform

---

## Acknowledgments

- MQTT.js and Mosquitto communities for robust messaging infrastructure
- Leaflet.js for interactive mapping
- OpenAI Whisper for speech recognition
- PyTorch and HuggingFace for model libraries

---

**FlashRescue** — *Empowering rapid, coordinated disaster response with trust-scored intelligence.*
<img width="1536" height="1024" alt="ChatGPT Image Jul 13, 2026, 09_41_22 PM" src="https://github.com/user-attachments/assets/26b5d51f-9949-49d0-80b8-13493578d18c" />
