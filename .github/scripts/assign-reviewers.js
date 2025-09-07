const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;
const path = require('path');
const { minimatch } = require('minimatch');

module.exports = async ({github, context, core}) => {
  const config = JSON.parse(
    await fs.readFile('.github/reviewers-config.json', 'utf8')
  );

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });

  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request.number;
  const prAuthor = context.payload.pull_request.user.login;

  // PR에서 변경된 파일 목록 가져오기
  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber
  });

  let reviewers = new Set();

  // 1. 도메인별 지정된 리뷰어 확인
  for (const file of files) {
    const domainReviewers = await getCodeOwners(file.filename, config.codeOwners);
    domainReviewers.forEach(r => reviewers.add(r));
  }

  // 2. 수정된 라인의 최근 작성자 찾기
  if (reviewers.size === 0) {
    for (const file of files) {
      if (file.status === 'modified') {
        const blameReviewers = await getBlameReviewers(
          octokit, owner, repo, file, prAuthor
        );
        blameReviewers.forEach(r => reviewers.add(r));
      }
    }
  }

  // 3. 리뷰어가 없으면 기본 리뷰어 지정
  if (reviewers.size === 0) {
    config.defaultReviewers.forEach(r => reviewers.add(r));
  }

  // PR 작성자 제외
  if (config.excludeAuthors) {
    reviewers.delete(prAuthor);
  }

  // 시간대 필터링
  if (config.timezone?.enabled) {
    reviewers = await filterByTimezone(reviewers, config.timezone);
  }

  // Organization 멤버 확인
  reviewers = await filterOrganizationMembers(
    octokit, owner, Array.from(reviewers)
  );

  // 최대 리뷰어 수 제한
  const finalReviewers = Array.from(reviewers).slice(0, config.maxReviewers);

  // 리뷰어 지정
  if (finalReviewers.length > 0) {
    await octokit.pulls.requestReviewers({
      owner,
      repo,
      pull_number: prNumber,
      reviewers: finalReviewers
    });

    console.log(`✅ Assigned reviewers: ${finalReviewers.join(', ')}`);
  } else {
    console.log('⚠️ No suitable reviewers found');
  }
};

// 도메인별 코드 오너 찾기
async function getCodeOwners(filename, codeOwners) {
  const reviewers = [];
  
  for (const [pattern, owners] of Object.entries(codeOwners)) {
    if (minimatch(filename, pattern) || filename.startsWith(pattern)) {
      reviewers.push(...owners);
    }
  }
  
  return reviewers;
}

// Git blame으로 최근 수정자 찾기
async function getBlameReviewers(octokit, owner, repo, file, prAuthor) {
  const reviewers = new Set();
  
  try {
    // 변경된 라인 범위 파싱
    const hunks = parseHunks(file.patch);
    
    for (const hunk of hunks) {
      // blame API 호출
      const { data: blameData } = await octokit.request(
        'GET /repos/{owner}/{repo}/blame/{path}',
        {
          owner,
          repo,
          path: file.filename,
          sha: file.sha
        }
      );

      // 변경된 라인의 작성자 추출
      for (const range of blameData) {
        if (isLineInHunk(range.lines, hunk)) {
          const author = range.commit.author?.login;
          if (author && author !== prAuthor) {
            reviewers.add(author);
            if (reviewers.size >= 2) break;
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error getting blame for ${file.filename}:`, error.message);
  }
  
  return Array.from(reviewers).slice(0, 2);
}

// Patch 파싱하여 변경된 라인 범위 추출
function parseHunks(patch) {
  if (!patch) return [];
  
  const hunks = [];
  const lines = patch.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        hunks.push({
          oldStart: parseInt(match[1]),
          newStart: parseInt(match[2])
        });
      }
    }
  }
  
  return hunks;
}

// 라인이 변경 범위에 포함되는지 확인
function isLineInHunk(lines, hunk) {
  const lineNumbers = lines.map(l => l.line_number);
  return lineNumbers.some(num => 
    num >= hunk.newStart && num < hunk.newStart + 10
  );
}

// 시간대별 필터링
async function filterByTimezone(reviewers, timezoneConfig) {
  const currentHour = new Date().getHours();
  const filtered = new Set();
  
  for (const reviewer of reviewers) {
    const userTz = timezoneConfig.userTimezones[reviewer];
    if (!userTz) {
      filtered.add(reviewer); // 시간대 정보 없으면 포함
      continue;
    }
    
    // 사용자의 현지 시간 계산
    const userTime = new Date().toLocaleString('en-US', {
      timeZone: userTz,
      hour: 'numeric',
      hour12: false
    });
    const userHour = parseInt(userTime);
    
    // 근무 시간 확인
    if (userHour >= timezoneConfig.workingHours.start && 
        userHour < timezoneConfig.workingHours.end) {
      filtered.add(reviewer);
    }
  }
  
  return filtered;
}

// Organization 멤버 확인
async function filterOrganizationMembers(octokit, org, reviewers) {
  const validReviewers = [];
  
  for (const reviewer of reviewers) {
    try {
      await octokit.orgs.checkMembershipForUser({
        org,
        username: reviewer
      });
      validReviewers.push(reviewer);
    } catch (error) {
      console.log(`⚠️ ${reviewer} is not in the organization`);
    }
  }
  
  return validReviewers;
}
