// 로컬에서 테스트하기 위한 스크립트
const { Octokit } = require('@octokit/rest');

async function testReviewerAssignment() {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });

  // 테스트용 mock context
  const mockContext = {
    repo: {
      owner: 'your-org',
      repo: 'your-repo'
    },
    payload: {
      pull_request: {
        number: 123,
        user: { login: 'test-author' },
        base: { sha: 'abc123' }
      },
      repository: {
        owner: { type: 'Organization' }
      }
    }
  };

  const mockCore = {
    info: console.log,
    warning: console.warn,
    error: console.error,
    setFailed: (msg) => {
      console.error('FAILED:', msg);
      process.exit(1);
    }
  };

  const assignReviewers = require('./assign-reviewers.js');
  await assignReviewers({
    github: octokit,
    context: mockContext,
    core: mockCore
  });
}

// 실행
testReviewerAssignment().catch(console.error);
