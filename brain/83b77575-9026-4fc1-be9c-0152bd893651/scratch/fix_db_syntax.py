import json

file_path = 'd:/Projects/Convo/Ai Automation/Talent Acquisition/stateless_agent_workflow.json'

with open(file_path, 'r') as f:
    wf = json.load(f)

# We need to replace $node['Node Name'] with $('Node Name').first()
# in all string values inside parameters of the DB nodes we added.

def fix_expression(expr):
    if not isinstance(expr, str):
        return expr
    
    expr = expr.replace("$node['Webhook - Answer']", "$('Webhook - Answer').first()")
    expr = expr.replace("$node['AI Agent - Answer']", "$('AI Agent - Answer').first()")
    expr = expr.replace("$node[\"Webhook - Answer\"]", "$('Webhook - Answer').first()")
    expr = expr.replace("$node[\"AI Agent - Answer\"]", "$('AI Agent - Answer').first()")
    return expr

for node in wf.get('nodes', []):
    if node['name'] in ["Update Answer in DB", "Insert Next Question in DB", "Update Session in DB", "If Final Phase"]:
        params = node.get('parameters', {})
        for key, val in params.items():
            if isinstance(val, str):
                params[key] = fix_expression(val)
            elif isinstance(val, dict):
                # Check for conditions object in If node
                if key == 'conditions':
                    for cond_type, cond_list in val.items():
                        for cond in cond_list:
                            cond['value1'] = fix_expression(cond['value1'])
                            cond['value2'] = fix_expression(cond['value2'])

with open(file_path, 'w') as f:
    json.dump(wf, f, indent=2)
