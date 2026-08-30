package com.example.groupware.controller;

import com.example.groupware.service.DeptService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/depts")
public class DeptController {

    private final DeptService deptService;

    public DeptController(DeptService deptService) {
        this.deptService = deptService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping
    public List<Map<String, Object>> list() {
        return deptService.findAll();
    }
}
