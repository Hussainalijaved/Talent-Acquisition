import urllib.request
import json

def main():
    url = "https://vnxstyadacgntnsvcvzn.supabase.co/rest/v1/assessment_sessions?order=updated_at.desc&limit=2"
    headers = {
        "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZueHN0eWFkYWNnbnRuc3ZjdnpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjAwMjAsImV4cCI6MjA5MzYzNjAyMH0.4rJRI_f6HyQNGYLHaw2ZH6q706ey8ftUVxzvzWEwD4",
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZueHN0eWFkYWNnbnRuc3ZjdnpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjAwMjAsImV4cCI6MjA5MzYzNjAyMH0.4rJRI_f6HyQNGYLHaw2ZH6q706ey8ftUVxzvzWEwD4",
        "Accept": "application/json"
    }
    
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            print("Database content:")
            print(json.dumps(data, indent=2))
    except Exception as e:
        print("Error fetching database row:", e)

if __name__ == "__main__":
    main()
