import json

file_path = 'd:/Projects/Convo/Ai Automation/Talent Acquisition/stateless_agent_workflow.json'

with open(file_path, 'r') as f:
    wf = json.load(f)

# Base header for Supabase HTTP requests
headers = {
    "parameters": [
        { "name": "apikey", "value": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}" },
        { "name": "Authorization", "value": "=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}" },
        { "name": "Prefer", "value": "return=representation" }
    ]
}

# 1. Update Answer in DB
update_answer_node = {
    "parameters": {
        "method": "PATCH",
        "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_questions?session_id=eq.{{ $node['Webhook - Answer'].json.body.sessionId }}&phase=eq.{{ $node['Webhook - Answer'].json.body.phase }}",
        "sendHeaders": True,
        "headerParameters": headers,
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ answer_text: $node['Webhook - Answer'].json.body.answer, received_at: new Date().toISOString() }) }}"
    },
    "id": "update-answer-db",
    "name": "Update Answer in DB",
    "type": "n8n-nodes-base.httpRequest",
    "typeVersion": 4.1,
    "position": [ 750, 800 ]
}

# 2. Insert Next Question
insert_question_node = {
    "parameters": {
        "method": "POST",
        "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_questions",
        "sendHeaders": True,
        "headerParameters": headers,
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ session_id: $node['Webhook - Answer'].json.body.sessionId, phase: $node['Webhook - Answer'].json.body.phase + 1, question_text: $node['AI Agent - Answer'].json.output.nextQuestion || $node['AI Agent - Answer'].json.output.question || '', sent_at: new Date().toISOString() }) }}"
    },
    "id": "insert-question-db",
    "name": "Insert Next Question in DB",
    "type": "n8n-nodes-base.httpRequest",
    "typeVersion": 4.1,
    "position": [ 950, 750 ]
}

# 3. Update Session Status
update_session_node = {
    "parameters": {
        "method": "PATCH",
        "url": "={{ $env.SUPABASE_URL }}/rest/v1/assessment_sessions?id=eq.{{ $node['Webhook - Answer'].json.body.sessionId }}",
        "sendHeaders": True,
        "headerParameters": headers,
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ status: 'completed', score: $node['AI Agent - Answer'].json.output.score || 0, result: $node['AI Agent - Answer'].json.output.result || 'FAIL', updated_at: new Date().toISOString() }) }}"
    },
    "id": "update-session-db",
    "name": "Update Session in DB",
    "type": "n8n-nodes-base.httpRequest",
    "typeVersion": 4.1,
    "position": [ 950, 900 ]
}

# 4. IF condition to check if it's final
if_node = {
    "parameters": {
        "conditions": {
            "boolean": [
                {
                    "value1": "={{ $node['AI Agent - Answer'].json.output.isFinal === true || $node['AI Agent - Answer'].json.output.result !== undefined }}",
                    "value2": True
                }
            ]
        }
    },
    "id": "check-if-final",
    "name": "If Final Phase",
    "type": "n8n-nodes-base.if",
    "typeVersion": 1,
    "position": [ 750, 950 ]
}

wf['nodes'].extend([update_answer_node, insert_question_node, update_session_node, if_node])

# Update connections
# Disconnect AI Agent - Answer from Respond Answer, route it through DB logic
# Actually, since respond to webhook needs to be quick, we can route Agent -> Respond Answer
# AND Agent -> Update Answer DB -> If Final -> Insert Next / Update Session

wf['connections']["AI Agent - Answer"]["main"][0].append({
    "node": "Update Answer in DB",
    "type": "main",
    "index": 0
})

wf['connections']["Update Answer in DB"] = {
    "main": [
        [
            {
                "node": "If Final Phase",
                "type": "main",
                "index": 0
            }
        ]
    ]
}

wf['connections']["If Final Phase"] = {
    "main": [
        [
            {
                "node": "Update Session in DB",
                "type": "main",
                "index": 0
            }
        ],
        [
            {
                "node": "Insert Next Question in DB",
                "type": "main",
                "index": 0
            }
        ]
    ]
}

with open(file_path, 'w') as f:
    json.dump(wf, f, indent=2)
