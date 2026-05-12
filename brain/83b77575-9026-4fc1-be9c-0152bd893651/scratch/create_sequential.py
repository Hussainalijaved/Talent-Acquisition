import json
import uuid
import os

def nid():
    return str(uuid.uuid4())

# Sequential Loop-based Workflow (One Execution)
def create_sequential_workflow():
    workflow = {
        "name": "AI Assessment Portal - Sequential Loop",
        "nodes": [
            {
                "parameters": {
                    "httpMethod": "POST",
                    "path": "assessment-start",
                    "options": {}
                },
                "id": nid(),
                "name": "Webhook - Start Session",
                "type": "n8n-nodes-base.webhook",
                "typeVersion": 2,
                "position": [100, 300],
                "webhookId": "assessment-start"
            },
            {
                "parameters": {
                    "method": "GET",
                    "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_sessions?id=eq.{{ $json.body.sessionId }}&select=*,jobs(*)",
                    "sendHeaders": True,
                    "headerParameters": {
                        "parameters": [
                            {"name": "apikey", "value": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}"},
                            {"name": "Authorization", "value": "=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}"}
                        ]
                    }
                },
                "id": nid(),
                "name": "HTTP - Fetch CV & JD",
                "type": "n8n-nodes-base.httpRequest",
                "typeVersion": 4.2,
                "position": [300, 300]
            },
            {
                "parameters": {
                    "jsCode": """
const data = $input.first().json[0];
const cv = data.cv_plaintext || 'No CV text found';
const jd = data.jobs?.description || data.jobs?.jd_text || 'Standard Engineering Role';
const title = data.jobs?.title || 'Engineer';

return [{ json: { cv, jd, title, sessionId: data.id, currentPhase: 1, maxPhases: 5, history: [] } }];
"""
                },
                "id": nid(),
                "name": "CODE - Initialize Context",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [500, 300]
            },
            {
                "parameters": {
                    "jsCode": """
// This node acts as our Loop Head
const ctx = $input.first().json;
return [{ json: ctx }];
"""
                },
                "id": nid(),
                "name": "Loop Head",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [700, 300]
            },
            {
                "parameters": {
                    "jsCode": """
const ctx = $input.first().json;
const isFinal = ctx.currentPhase > ctx.maxPhases;

const sys = isFinal 
? `You are the Final Scorer. Review the CV, JD, and all Q&A history. 
   JD: ${ctx.jd}
   CV: ${ctx.cv}
   History: ${JSON.stringify(ctx.history)}
   Provide final score (0-100), result (PASS/FAIL), and feedback.`
: `You are a Technical Interviewer. 
   Role: ${ctx.title}
   JD Requirements: ${ctx.jd}
   Candidate CV: ${ctx.cv}
   Phase: ${ctx.currentPhase} of ${ctx.maxPhases}
   History: ${JSON.stringify(ctx.history)}
   
   Task: Generate a surgical technical question that tests the candidate's fit for this SPECIFIC JD based on their CV. 
   If they claim a skill in CV that JD needs, drill down. If they miss a skill JD needs, ask how they would handle it.`;

const body = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sys }],
    temperature: 0.2,
    response_format: { type: "json_object" }
};
return [{ json: { ...ctx, groq_request: body, isFinal } }];
"""
                },
                "id": nid(),
                "name": "CODE - Prepare AI Prompt",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [900, 300]
            },
            {
                "parameters": {
                    "method": "POST",
                    "url": "https://api.groq.com/openai/v1/chat/completions",
                    "sendHeaders": True,
                    "headerParameters": {
                        "parameters": [
                            {"name": "Authorization", "value": "=Bearer {{ $env.GROQ_API_KEY }}"},
                            {"name": "Content-Type", "value": "application/json"}
                        ]
                    },
                    "sendBody": True,
                    "specifyBody": "json",
                    "jsonBody": "={{ $json.groq_request }}"
                },
                "id": nid(),
                "name": "Groq - AI Engine",
                "type": "n8n-nodes-base.httpRequest",
                "typeVersion": 4.2,
                "position": [1100, 300]
            },
            {
                "parameters": {
                    "jsCode": """
const api = $input.first().json;
const content = JSON.parse(api.choices[0].message.content);
const ctx = $('CODE - Prepare AI Prompt').first().json;

return [{ json: { ...ctx, ai_response: content } }];
"""
                },
                "id": nid(),
                "name": "CODE - Parse AI Response",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [1300, 300]
            },
            {
                "parameters": {
                    "respondWith": "json",
                    "responseBody": "={{ $json.ai_response }}",
                    "options": {}
                },
                "id": nid(),
                "name": "Respond to Portal",
                "type": "n8n-nodes-base.respondToWebhook",
                "typeVersion": 1,
                "position": [1500, 200]
            },
            {
                "parameters": {
                    "resume": "webhook",
                    "options": {
                        "webhookSuffix": "answer"
                    }
                },
                "id": nid(),
                "name": "WAIT - For Candidate Answer",
                "type": "n8n-nodes-base.wait",
                "typeVersion": 1.1,
                "position": [1500, 400],
                "webhookId": "wait-for-answer"
            },
            {
                "parameters": {
                    "jsCode": """
const prevCtx = $('CODE - Parse AI Response').first().json;
const answerData = $input.first().json.body;

const newHistory = [...prevCtx.history, {
    phase: prevCtx.currentPhase,
    question: prevCtx.ai_response.nextQuestion || 'Final Review',
    answer: answerData.answer
}];

return [{ 
    json: { 
        ...prevCtx, 
        history: newHistory, 
        currentPhase: prevCtx.currentPhase + 1 
    } 
}];
"""
                },
                "id": nid(),
                "name": "CODE - Update History",
                "type": "n8n-nodes-base.code",
                "typeVersion": 2,
                "position": [1700, 400]
            }
        ],
        "connections": {
            "Webhook - Start Session": { "main": [[{ "node": "HTTP - Fetch CV & JD", "type": "main", "index": 0 }]] },
            "HTTP - Fetch CV & JD": { "main": [[{ "node": "CODE - Initialize Context", "type": "main", "index": 0 }]] },
            "CODE - Initialize Context": { "main": [[{ "node": "Loop Head", "type": "main", "index": 0 }]] },
            "Loop Head": { "main": [[{ "node": "CODE - Prepare AI Prompt", "type": "main", "index": 0 }]] },
            "CODE - Prepare AI Prompt": { "main": [[{ "node": "Groq - AI Engine", "type": "main", "index": 0 }]] },
            "Groq - AI Engine": { "main": [[{ "node": "CODE - Parse AI Response", "type": "main", "index": 0 }]] },
            "CODE - Parse AI Response": { 
                "main": [
                    [{ "node": "Respond to Portal", "type": "main", "index": 0 }],
                    [{ "node": "WAIT - For Candidate Answer", "type": "main", "index": 0 }]
                ] 
            },
            "WAIT - For Candidate Answer": { "main": [[{ "node": "CODE - Update History", "type": "main", "index": 0 }]] },
            "CODE - Update History": { "main": [[{ "node": "Loop Head", "type": "main", "index": 0 }]] }
        }
    }
    return workflow

wf = create_sequential_workflow()
out_path = r'd:\Projects\Convo\Ai Automation\Talent Acquisition\standalone_sequential_workflow.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(wf, f, indent=2)

print(f"Created {out_path}")
