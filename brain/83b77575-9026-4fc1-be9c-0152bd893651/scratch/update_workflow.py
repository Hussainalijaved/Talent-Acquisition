import json
import uuid
import os

def nid():
    return str(uuid.uuid4())

# Load the existing unified workflow
path = r'd:\Projects\Convo\Ai Automation\Talent Acquisition\talent_acquisition.json'
if not os.path.exists(path):
    print(f"Error: {path} not found")
    exit(1)

with open(path, 'r', encoding='utf-8') as f:
    wf = json.load(f)

# Define nodes for the Assessment Portal Flow
assessment_nodes = [
    {
        "parameters": {
            "httpMethod": "POST",
            "path": "assessment-init",
            "options": {}
        },
        "id": nid(),
        "name": "TRG - Webhook Assessment Init",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [100, 1800],
        "webhookId": "assessment-init"
    },
    {
        "parameters": {
            "httpMethod": "POST",
            "path": "assessment-submit",
            "options": {}
        },
        "id": nid(),
        "name": "TRG - Webhook Assessment Submit",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [100, 2000],
        "webhookId": "assessment-submit"
    },
    {
        "parameters": {
            "jsCode": """
const body = $input.first().json.body;
return [{ 
    json: { 
        sessionId: body.sessionId, 
        email: body.email, 
        answer: body.answer || '', 
        phase: body.phase || 1,
        tabSwitches: body.tabSwitches || 0
    } 
}];
"""
        },
        "id": nid(),
        "name": "CODE - Normalize Data",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [350, 1900]
    },
    {
        "parameters": {
            "method": "GET",
            "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_sessions?id=eq.{{ $json.sessionId }}&select=*",
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [
                    {"name": "apikey", "value": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}"},
                    {"name": "Authorization", "value": "=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}"}
                ]
            }
        },
        "id": nid(),
        "name": "HTTP - Fetch Session",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [550, 1900]
    },
    {
        "parameters": {
            "method": "GET",
            "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_questions?session_id=eq.{{ $('CODE - Normalize Data').first().json.sessionId }}&select=*",
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [
                    {"name": "apikey", "value": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}"},
                    {"name": "Authorization", "value": "=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}"}
                ]
            }
        },
        "id": nid(),
        "name": "HTTP - Fetch History",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [750, 1900]
    },
    {
        "parameters": {
            "conditions": {
                "options": {
                    "caseSensitive": True,
                    "leftValue": "",
                    "typeValidation": "strict",
                    "version": 2
                },
                "conditions": [
                    {
                        "id": "c1",
                        "leftValue": "={{ $('CODE - Normalize Data').first().json.phase }}",
                        "rightValue": 5,
                        "operator": {
                            "type": "number",
                            "operation": "largerEqual"
                        }
                    }
                ],
                "combinator": "and"
            },
            "options": {}
        },
        "id": nid(),
        "name": "IF - Final Phase?",
        "type": "n8n-nodes-base.if",
        "typeVersion": 2.2,
        "position": [950, 1900]
    },
    {
        "parameters": {
            "jsCode": """
const session = $('HTTP - Fetch Session').first().json[0];
const history = $('HTTP - Fetch History').first().json;
const current = $('CODE - Normalize Data').first().json;

const sys = `You are the Master Technical Evaluator. 
Final Phase reached. Review the candidate's CV and ALL answers provided during this session.
CV: ${session.cv_plaintext}
History: ${JSON.stringify(history)}
Final Answer: ${current.answer}
Tab Switches: ${current.tabSwitches}

Goal: Provide a final score (0-100) and a PASS/FAIL decision. 
If cheating is suspected (high tab switches or AI-like generic answers), reflect this in the feedback and score.

Response JSON:
{
  "status": "finished",
  "result": "PASS" | "FAIL",
  "score": number,
  "feedback": "string"
}`;

const body = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sys }],
    temperature: 0.1,
    response_format: { type: "json_object" }
};
return [{ json: { groq_request: body } }];
"""
        },
        "id": nid(),
        "name": "CODE - Prepare Final Score Prompt",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1150, 1800]
    },
    {
        "parameters": {
            "jsCode": """
const session = $('HTTP - Fetch Session').first().json[0];
const current = $('CODE - Normalize Data').first().json;

const sys = `You are a Technical Interviewer.
Candidate is in Phase ${current.phase} of 5.
CV: ${session.cv_plaintext.slice(0, 3000)}
Current Answer: ${current.answer}

Goal: Evaluate the current answer and generate the NEXT surgical technical question that drills deeper into a specific project or skill mentioned.
Stay professional and elite.

Response JSON:
{
  "status": "in_progress",
  "nextQuestion": "string",
  "feedback": "Short encouragement"
}`;

const body = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sys }],
    temperature: 0.3,
    response_format: { type: "json_object" }
};
return [{ json: { groq_request: body } }];
"""
        },
        "id": nid(),
        "name": "CODE - Prepare Next Question Prompt",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1150, 2000]
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
        "name": "Groq - AI Technical Engine",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [1400, 1900]
    },
    {
        "parameters": {
            "jsCode": """
const api = $input.first().json;
const content = JSON.parse(api.choices[0].message.content);
return [{ json: content }];
"""
        },
        "id": nid(),
        "name": "CODE - Parse Result",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1600, 1900]
    },
    {
        "parameters": {
            "method": "POST",
            "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_questions",
            "sendHeaders": True,
            "headerParameters": {
                "parameters": [
                    {"name": "apikey", "value": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}"},
                    {"name": "Authorization", "value": "=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}"},
                    {"name": "Content-Type", "value": "application/json"}
                ]
            },
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={\n  \"session_id\": \"{{ $('CODE - Normalize Data').first().json.sessionId }}\",\n  \"question_text\": \"{{ $('HTTP - Fetch Session').first().json[0].last_question || 'Initial' }}\",\n  \"answer_text\": \"{{ $('CODE - Normalize Data').first().json.answer }}\",\n  \"phase\": {{ $('CODE - Normalize Data').first().json.phase }}\n}"
        },
        "id": nid(),
        "name": "DB - Log Question/Answer",
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": [1800, 1900]
    },
    {
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ $('CODE - Parse Result').first().json }}",
            "options": {}
        },
        "id": nid(),
        "name": "Respond to Portal",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1,
        "position": [2000, 1900]
    }
]

# Update connections
wf['nodes'].extend(assessment_nodes)

if "connections" not in wf:
    wf["connections"] = {}

# Connect Assessment Portal nodes
wf["connections"]["TRG - Webhook Assessment Init"] = {"main": [[{"node": "CODE - Normalize Data", "type": "main", "index": 0}]]}
wf["connections"]["TRG - Webhook Assessment Submit"] = {"main": [[{"node": "CODE - Normalize Data", "type": "main", "index": 0}]]}
wf["connections"]["CODE - Normalize Data"] = {"main": [[{"node": "HTTP - Fetch Session", "type": "main", "index": 0}]]}
wf["connections"]["HTTP - Fetch Session"] = {"main": [[{"node": "HTTP - Fetch History", "type": "main", "index": 0}]]}
wf["connections"]["HTTP - Fetch History"] = {"main": [[{"node": "IF - Final Phase?", "type": "main", "index": 0}]]}
wf["connections"]["IF - Final Phase?"] = {
    "main": [
        [{"node": "CODE - Prepare Final Score Prompt", "type": "main", "index": 0}], # True
        [{"node": "CODE - Prepare Next Question Prompt", "type": "main", "index": 0}] # False
    ]
}
wf["connections"]["CODE - Prepare Final Score Prompt"] = {"main": [[{"node": "Groq - AI Technical Engine", "type": "main", "index": 0}]]}
wf["connections"]["CODE - Prepare Next Question Prompt"] = {"main": [[{"node": "Groq - AI Technical Engine", "type": "main", "index": 0}]]}
wf["connections"]["Groq - AI Technical Engine"] = {"main": [[{"node": "CODE - Parse Result", "type": "main", "index": 0}]]}
wf["connections"]["CODE - Parse Result"] = {"main": [[{"node": "DB - Log Question/Answer", "type": "main", "index": 0}]]}
wf["connections"]["DB - Log Question/Answer"] = {"main": [[{"node": "Respond to Portal", "type": "main", "index": 0}]]}

# Now the critical part: If PASS, trigger the Scheduling Flow
# The scheduling flow starts with "MAIL - Interviewer coordination agent" (id: 10cc696a-b3f9-4f1b-a471-be7615abffa4 in original)
# We add a condition check after Parse Result
wf["connections"]["CODE - Parse Result"]["main"].append({"node": "GATE - Check PASS for Scheduling", "type": "main", "index": 0})

scheduling_gate = {
    "parameters": {
        "conditions": {
            "options": { "caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2 },
            "conditions": [
                {
                    "id": "p1",
                    "leftValue": "={{ $json.result }}",
                    "rightValue": "PASS",
                    "operator": { "type": "string", "operation": "equals" }
                }
            ],
            "combinator": "and"
        },
        "options": {}
    },
    "id": nid(),
    "name": "GATE - Check PASS for Scheduling",
    "type": "n8n-nodes-base.if",
    "typeVersion": 2.2,
    "position": [1800, 1600]
}
wf['nodes'].append(scheduling_gate)
wf["connections"]["GATE - Check PASS for Scheduling"] = {
    "main": [
        [{"node": "MAIL - Interviewer coordination agent", "type": "main", "index": 0}] # True -> Start scheduling
    ]
}

# Final Save
out_path = r'd:\Projects\Convo\Ai Automation\Talent Acquisition\talent_acquisition_updated.json'
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(wf, f, indent=2)

print(f"Created {out_path}")
