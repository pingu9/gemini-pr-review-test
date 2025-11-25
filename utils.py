"""
간단한 유틸리티 함수 모음
"""

def greet(name: str) -> str:
    """인사 메시지를 반환합니다."""
    return f"안녕하세요, {name}님!"


def add_numbers(a: int, b: int) -> int:
    """두 숫자를 더합니다."""
    return a + b


def is_even(number: int) -> bool:
    """숫자가 짝수인지 확인합니다."""
    return number % 2 == 0


if __name__ == "__main__":
    print(greet("Claude"))
    print(f"3 + 5 = {add_numbers(3, 5)}")
    print(f"4는 짝수인가요? {is_even(4)}")
