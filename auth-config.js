/**
 * Shared Supabase config — public anon key (safe for browser).
 * Admin writes require authenticated JWT + RLS role policies.
 */
(function (global) {
    'use strict';
    global.TA_CONFIG = {
        SUPABASE_URL: 'https://vnxstyadacgntnsvcvzn.supabase.co',
        SUPABASE_ANON_KEY:
            'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZueHN0eWFkYWNnbnRuc3ZjdnpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjAwMjAsImV4cCI6MjA5MzYzNjAyMH0.4rJRI_f6HyQNGYLHaw2ZH6q7060ey8ftUVxzvzWEwD4',
    };
})(typeof window !== 'undefined' ? window : globalThis);
